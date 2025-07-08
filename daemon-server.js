const net = require('net');
const ProcessDaemon = require('./process-daemon');
const fs = require('fs');
const Logger = require('./logger'); // 假设你有 logger 工具
const path = require('path');
const SOCKET_PATH = '/tmp/wd-daemon.sock';

if (fs.existsSync(SOCKET_PATH)) fs.unlinkSync(SOCKET_PATH);

const managed = {}; // name -> ProcessDaemon
const logger = new Logger();

const server = net.createServer(socket => {
  socket.on('data', async (data) => {
    let msg;   
    try { msg = JSON.parse(data.toString()); } catch(e) { 
      logger.write('system',JSON.stringify(e));
      return; }    
    if (msg.cmd === 'start') {
      if (!managed[msg.name]) {
        managed[msg.name] = new ProcessDaemon(msg.script, { name: msg.name });
        socket.write(JSON.stringify({ ok: true, msg: 'started' }));
      } else {
        socket.write(JSON.stringify({ ok: false, msg: 'already running' }));
      }
    } else if (msg.cmd === 'list') {
      const list = await Promise.all(Object.values(managed).map(d => d.getStatus()));
      socket.write(JSON.stringify({ ok: true, list }));
    } else if (msg.cmd === 'stop') {
      if (managed[msg.name]) {
        await managed[msg.name].stop();
        delete managed[msg.name];
        socket.write(JSON.stringify({ ok: true, msg: 'stopped' }));
      } else {
        socket.write(JSON.stringify({ ok: false, msg: 'not found' }));
      }
    } else if (msg.cmd === 'logs') {
        console.log('logs cmd:', msg); // 调试
      let content = logger.readAppLog(msg.name, msg.type || 'out');
      console.log('读取到的日志内容:', content); // 调试
      if (!content && msg.name) {
        // 兼容不带扩展名的情况
        const baseName = msg.name.replace(/\.[^/.]+$/, "");
        content = logger.readAppLog(baseName, msg.type || 'out');
      }
      if (!content && !msg.name) {
        content = logger.read('system');
      }      
      socket.write(JSON.stringify({
        ok: !!content,
        content: content || '',
        msg: content ? '' : '日志文件不存在'
      }));
    } else if (msg.cmd === 'start-config') {
      const configPath = path.resolve(process.cwd(), msg.config);
      let apps;
      try {
        delete require.cache[require.resolve(configPath)];
        apps = require(configPath);
        if (!apps || !Array.isArray(apps.apps)) {
          socket.write(JSON.stringify({ ok: false, msg: '配置文件格式错误，必须导出 { apps: [...] }' }));
          return;
        }
      } catch (e) {
        socket.write(JSON.stringify({ ok: false, msg: '配置文件解析失败: ' + e.message }));
        return;
      }
      let started = 0;
      for (const app of apps.apps) {
        if (!managed[app.name]) {
          managed[app.name] = new ProcessDaemon(app.script, { ...app, name: app.name });
          started++;
        }
      }
      socket.write(JSON.stringify({ ok: true, msg: `批量启动${started}个应用` }));
    }
    // 可扩展 restart 等命令
  });
});

// server.listen(SOCKET_PATH, () => {
//   console.log('wd 守护主进程已启动:', SOCKET_PATH);
// });

server.listen(2888, '127.0.0.1', () => {
  console.log('wd 守护主进程已启动:', SOCKET_PATH);
});