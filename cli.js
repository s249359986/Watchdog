#!/usr/bin/env node

const net = require('net');
const { fork } = require('child_process');
const fs = require('fs');
const path = require('path');
const SOCKET_PATH = '/tmp/wd-daemon.sock';
const commander = require('commander');
const program = new commander.Command();

// 自动检测并启动守护进程
function ensureDaemon(cb) {
  const client = net.createConnection(SOCKET_PATH, () => {
    client.end();
    cb();
  });
  client.on('error', () => {
    // 守护进程不存在，自动启动
    const daemonPath = path.resolve(__dirname, 'daemon-server.js');
    const daemon = fork(daemonPath, [], {
      detached: true,
      stdio: 'ignore'
    });
    daemon.unref();

    // 等待守护进程 ready（轮询 socket 文件）
    let retries = 0;
    const maxRetries = 20;
    const waitForSocket = () => {
      if (fs.existsSync(SOCKET_PATH)) {
        setTimeout(cb, 100);
      } else if (retries++ < maxRetries) {
        setTimeout(waitForSocket, 100);
      } else {
        console.error('守护进程启动失败');
        process.exit(1);
      }
    };
    waitForSocket();
  });
}

function send(cmdObj, cb) {
  const client = net.createConnection(SOCKET_PATH, () => {
    client.write(JSON.stringify(cmdObj));
  });
  client.on('data', data => {
    cb(JSON.parse(data.toString()));
    client.end();
  });
  client.on('error', err => {
    console.error('守护进程通信失败:', err.message);
    process.exit(1);
  });
}

// 解析命令行参数
program
  .command('start [script]')
  .option('-c, --config <file>', '配置文件')
  .action((script, options) => {
    ensureDaemon(() => {
      if (options.config) {
        send({ cmd: 'start-config', config: options.config }, res => {
          console.log(res.ok ? res.msg : '启动失败: ' + res.msg);
        });
      } else {
        send({ cmd: 'start', name: script, script }, res => {
          console.log(res.msg);
        });
      }
    });
  });

program
  .command('list')
  .action(() => {
    ensureDaemon(() => {
      send({ cmd: 'list' }, res => {
        console.table(res.list);
      });
    });
  });

program
  .command('stop <name>')
  .action(name => {
    ensureDaemon(() => {
      send({ cmd: 'stop', name }, res => {
        console.log(res.msg);
      });
    });
  });

program
  .command('logs <name> [type]')
  .action((name, type) => {
    ensureDaemon(() => {
      send({ cmd: 'logs', name, type: type || 'out' }, res => {
        if (res.ok) {
          console.log(res.content);
        } else {
          console.log(res.msg);
        }
      });
    });
  });

program.parse(process.argv);