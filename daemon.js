#!/usr/bin/env node

const { spawn } = require("child_process");
const path = require("path");
const { Command } = require("commander");
const pidusage = require("pidusage");
const Logger = require("./logger");
const fs = require("fs");
const os = require("os");

const logger = new Logger();

class ProcessDaemon {
  constructor(scriptPath, options = {}) {
    this.scriptPath = path.resolve(scriptPath);
    this.options = options;
    this.child = null;
    this.memoryCheckInterval = null;
    this.startTime = Date.now();
    this.restartCount = 0;
    this.name = options.name || path.basename(scriptPath);
    // 确保使用完整的临时目录路径
    this.pidFile = path.join(os.tmpdir(), `mypm2-${this.name}.pid`);
    
    // 确保日志目录存在
    this.ensureLogDir();
    
    // 只有非恢复的进程才需要启动
    if (!options.isRestore) {
      this.start();
    }
}

  ensureLogDir() {
    const logDir = "./logs";
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
  }

  async start() {
    try {
      // 先尝试停止现有进程
      await this.stop();
    } catch (err) {
      // 忽略首次启动时找不到PID文件的错误
      if (err.code !== 'ENOENT') {
        throw err;
      }
    }

    const args = [this.scriptPath];

    // 设置环境变量
    const envConfig =
      process.env.NODE_ENV === "production"
        ? this.options.env_production || {}
        : this.options.env || {};

    const env = {
      detached: true, // 设置为分离模式
      stdio: ["ignore", "pipe", "pipe"], // 重定向标准输入输出
      ...process.env,
      ...envConfig,
    };
    console.log("args", JSON.stringify(args));

    // 创建日志文件流
    const outFile = fs.openSync(`./logs/${this.name}-out.log`, "a");
    const errorFile = fs.openSync(`./logs/${this.name}-error.log`, "a");

    const spawnOptions = {
      env,
      detached: true,
      stdio: ["ignore", outFile, errorFile], // 重定向到文件
      windowsHide: true, // 在 Windows 上隐藏终端窗口
    };

    this.child = spawn('node', args, spawnOptions);
    this.child.unref();

    // 确保进程成功启动后才写入 PID 文件
    await new Promise((resolve, reject) => {
      this.child.once('error', reject);
      this.child.once('spawn', () => {
        try {
          const pidPath = path.join(os.tmpdir(), `mypm2-${this.name}.pid`);
          fs.writeFileSync(pidPath, String(this.child.pid));
          console.log(`PID 文件已写入: ${pidPath}`);
          resolve();
        } catch (err) {
          console.error('写入 PID 文件失败:', err);
          reject(err);
        }
      });
    });
    
    // 记录启动信息
    logger.write(
      "system",
      JSON.stringify({
        event: "process_start",
        name: this.name,
        pid: this.child.pid,
        script: this.scriptPath,
        time: new Date().toISOString(),
      })
    );

    // 添加内存监控
    if (this.options.max_memory_restart) {
      this.setupMemoryMonitor();
    }

    // 不再需要直接监听stdout和stderr事件
    // 因为已经重定向到文件了

    // 监听子进程错误
    this.child.on("error", (err) => {
      logger.write("system", `进程启动失败: ${err.message}`);
    });

    // 监听子进程退出
    this.child.on("close", (code) => {
      const msg = `子进程退出，代码 ${code}`;
      logger.write("system", msg);

      // 只有非正常退出(code不为0)时才自动重启
      if (code !== 0) {
        setTimeout(() => this.start(), 1000);
      }
    });
  }

  setupMemoryMonitor() {
    const maxMemory = this.parseMemory(this.options.max_memory_restart);

    this.memoryCheckInterval = setInterval(() => {
      if (!this.child) return;

      const memoryUsage = process.memoryUsage().rss;
      logger.write(
        "system",
        `内存最大设置${maxMemory}，当前使用${memoryUsage}`
      );
      if (memoryUsage > maxMemory) {
        logger.write(
          "system",
          `内存使用超过限制 ${this.options.max_memory_restart}, 重启进程`
        );
        this.child.kill();
        this.start();
      }
    }, 5000); // 每5秒检查一次
  }

  parseMemory(memoryStr) {
    const units = {
      K: 1024,
      M: 1024 * 1024,
      G: 1024 * 1024 * 1024,
    };

    const match = memoryStr.match(/^(d+)([KMG])?$/);
    if (!match) return 0;

    const value = parseInt(match[1]);
    const unit = match[2] || "M";

    return value * units[unit];
  }

  parseMemory(str) {
    const unitMap = {
      g: Math.pow(1024, 3), // Gigabytes
      m: Math.pow(1024, 2), // Megabytes
      k: 1024, // Kilobytes
      b: 1, // Bytes
    };

    // 正则表达式解析字符串，提取数字和单位
    const match = str
      .trim()
      .toLowerCase()
      .match(/^(\d+)([gmkb]?)$/);
    if (!match) {
      throw new Error("Invalid memory format");
    }

    const value = parseInt(match[1], 10);
    const unit = match[2];

    // 根据单位计算字节数
    if (unit === "g") {
      // 吉字节 (G)
      return value * unitMap.g;
    } else if (unit === "m") {
      // 兆字节 (M)
      return value * unitMap.m;
    } else if (unit === "k") {
      // 千字节 (k)
      return value * unitMap.k;
    } else if (unit === "b") {
      // 字节 (b)
      return value;
    } else {
      throw new Error("Unsupported unit");
    }
  }

  async stop() {
    if (this.memoryCheckInterval) {
      clearInterval(this.memoryCheckInterval);
      this.memoryCheckInterval = null;
    }

    try {
      // 检查是否有活跃的子进程或PID文件
      let pid;
      if (this.child && this.child.pid) {
        pid = this.child.pid;
      } else if (fs.existsSync(this.pidFile)) {
        pid = parseInt(fs.readFileSync(this.pidFile, 'utf8'));
      } else {
        // 没有需要停止的进程
        return;
      }
      
      try {
        // 尝试终止进程
        process.kill(pid, 'SIGTERM');
        
        // 删除 PID 文件
        if (fs.existsSync(this.pidFile)) {
          fs.unlinkSync(this.pidFile);
        }
        
        // 记录停止信息
        logger.write('system', JSON.stringify({
          event: 'process_stop',
          name: this.name,
          pid: pid,
          time: new Date().toISOString()
        }));

        // 重置进程状态
        this.child = null;
        
        // 等待一段时间确保进程完全退出
        await new Promise(resolve => setTimeout(resolve, 1000));
        
      } catch (err) {
        if (err.code === 'ESRCH') {
          // 进程已经不存在，只需要清理PID文件
          if (fs.existsSync(this.pidFile)) {
            fs.unlinkSync(this.pidFile);
          }
        } else {
          throw err;
        }
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error(`停止进程 ${this.name} 失败:`, err);
        throw err;
      }
    }
}

  // 修改getStatus方法
  async getStatus() {
    try {
      const pid = this.child
        ? this.child.pid
        : parseInt(fs.readFileSync(this.pidFile, "utf8"));
      const stats = await pidusage(pid);
      const uptime = Math.floor((Date.now() - this.startTime) / 1000);

      return {
        name: this.name,
        pid: pid,
        memory: `${Math.round(stats.memory / (1024 * 1024))} MB`,
        cpu: `${stats.cpu.toFixed(1)}%`,
        uptime: `${uptime}s`,
        restarts: this.restartCount,
        status: "online",
      };
    } catch (err) {
      return {
        name: this.name,
        pid: "N/A",
        memory: "N/A",
        cpu: "N/A",
        uptime: "N/A",
        restarts: this.restartCount,
        status: "stopped",
      };
    }
  }

  static async getAllRunningProcesses() {
    const tempDir = os.tmpdir();
    console.log('正在检查临时目录:', tempDir);
    
    const pidFiles = fs.readdirSync(tempDir)
      .filter(file => file.startsWith('mypm2-'));
    
    console.log('找到的PID文件:', pidFiles);
    
    const processes = [];

    for (const pidFile of pidFiles) {
      try {
        const pidPath = path.join(tempDir, pidFile);
        console.log('正在检查PID文件:', pidPath);
        
        const pid = parseInt(fs.readFileSync(pidPath, 'utf8'));
        
        try {
          const { execSync } = require('child_process');
          console.log(`正在检查PID: ${pid}`);
          
          // 修改为 macOS 兼容的命令
          const psCmd = `ps -p ${pid} -o command=`;
          console.log(`执行命令: ${psCmd}`);
          
          const output = execSync(psCmd, { encoding: 'utf8' }).trim();
          console.log('进程信息:', output);
          
          // 检查是否是 node 进程
          if (output.includes('node')) {
            console.log('找到运行中的 node 进程:', pid);
            
            const name = pidFile.replace('mypm2-', '').replace('.pid', '');
            
            // 从命令输出中提取脚本路径
            const args = output.split(/\s+/);
            const scriptPath = args.find(arg => arg.endsWith('.js')) || name;
            
            console.log('脚本路径:', scriptPath);
            
            // 创建新的守护进程实例
            const daemon = new ProcessDaemon(scriptPath, {
              name,
              isRestore: true
            });
            
            // 设置进程信息
            daemon.child = { pid };
            daemon.startTime = Date.now();
            
            processes.push(daemon);
          } else {
            console.log('进程不是 node 进程，清理 PID 文件:', pidPath);
            fs.unlinkSync(pidPath);
          }
        } catch (e) {
          // 检查错误状态
          console.log('检查进程失败:', e);
          if (e.status === 1) {            
            console.log('进程不存在，清理 PID 文件:', pidPath);
            fs.unlinkSync(pidPath);
          } else {
            console.error('检查进程失败1:', e);
          }
        }
      } catch (err) {
        console.error(`处理PID文件失败: ${pidFile}`, err);
      }
    }

    console.log('找到的运行进程数:', processes.length);
    return processes;
}
}

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

        const tail = require('child_process').spawn('tail', ['-f', logFile]);
        
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
