#!/usr/bin/env node

const { spawn } = require("child_process");
const path = require("path");
const { Command } = require("commander");
const Logger = require("./logger");
const ProcessDaemon = require("./process-daemon");
const logger = new Logger();


// 添加list命令
// 在文件开头const声明之后添加
const program = new Command();
let allowExit = false;
// 修改全局变量跟踪所有守护进程实例
let daemonInstances = [];

program
  .command("list")
  .description("列出所有运行中的应用及其状态")
  .action(async () => {
    try {
      // 获取所有运行中的进程
      const runningProcesses = await ProcessDaemon.getAllRunningProcesses();

      if (runningProcesses.length === 0) {
        console.log("没有运行中的应用");
        return;
      }

      console.log("应用列表:");

      // 使用Promise.all等待所有状态获取完成
      const statuses = await Promise.all(
        runningProcesses.map((p) => p.getStatus())
      );

      console.table(statuses);
    } catch (err) {
      console.error("获取进程状态失败:", err);
    }
  });

program
  .command("start [script|config]")
  .description("启动应用或从配置文件启动")
  .option("-c, --config", "使用配置文件启动")
  .option("-p, --production", "使用生产环境配置")
  .action((input, options) => {
    if (options.production) {
      process.env.NODE_ENV = "production";
    }

    if (options.config) {
      const config = require(path.resolve(input || "./start.config.js"));
      daemonInstances = config.apps.map((app) => {
        console.log(`启动应用: ${app.name} (${app.script})`);
        return new ProcessDaemon(app.script, app);
      });
    } else {
      console.log(`启动应用: ${input}`);
      daemonInstances = [new ProcessDaemon(input)];
    }
  });

// 将stop命令移到这里
program
  .command("stop")
  .description("停止守护的进程")
  .action(async () => {
    try {
      const runningProcesses = await ProcessDaemon.getAllRunningProcesses();
      if (runningProcesses.length === 0) {
        console.log("没有运行中的应用");
        return;
      }

      // 停止所有进程
      await Promise.all(runningProcesses.map((instance) => instance.stop()));
      console.log("已停止所有应用");
    } catch (err) {
      console.error("停止进程失败:", err);
    }
  });

program
  .command('logs [app] [type]')
  .description('查看日志文件')
  .option('-f, --follow', '实时查看日志')
  .option('-n, --lines <n>', '显示最后n行', '100')
  .action(async (app, type = 'out', options) => {
    try {
      // 如果没有指定应用名称，显示系统日志
      if (!app) {
        const systemLog = logger.read('system');
        if (!systemLog) {
          console.log('没有找到系统日志文件');
          return;
        }
        console.log(systemLog);
        return;
      }

      // 获取应用日志
      const logContent = logger.readAppLog(app, type);
      if (!logContent) {
        console.log(`没有找到应用 ${app} 的 ${type} 日志文件`);
        return;
      }

      // 如果指定了行数，只显示最后n行
      if (options.lines) {
        const lines = logContent.split('\n');
        const lastLines = lines.slice(-parseInt(options.lines)).join('\n');
        console.log(lastLines);
      } else {
        console.log(logContent);
      }

      // 如果使用 -f 参数，则实时查看日志
      if (options.follow) {
        const logFile = logger.getAppLogFile(app, type);
        if (!logFile) {
          console.log('无法找到日志文件');
          return;
        }

        const tail = spawn('tail', ['-f', logFile]);
        
        tail.stdout.on('data', (data) => {
          process.stdout.write(data);
        });

        // 处理 Ctrl+C
        process.on('SIGINT', () => {
          tail.kill();
          process.exit();
        });
      }
    } catch (err) {
      console.error('查看日志失败:', err);
    }
  });

// 放在所有命令定义之后
program.parse(process.argv);

// 处理退出信号
// 修改现有的SIGINT处理逻辑

// 修改SIGINT处理逻辑
process.on("SIGINT", () => {
  if (allowExit) {
    // 停止所有守护进程实例
    daemonInstances.forEach((instance) => instance.stop());
    daemonInstances = [];
    process.exit();
  } else {
    console.log("请使用 `mypm2 stop` 命令来停止程序");
    console.log("或者再次按Ctrl+C强制退出（不推荐）");
    allowExit = true;
    setTimeout(() => {
      allowExit = false;
    }, 2000);
  }
});
