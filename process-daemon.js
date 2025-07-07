const { spawn, execSync } = require("child_process");
const path = require("path");
const pidusage = require("pidusage");
const fs = require("fs");
const os = require("os");
const Logger = require("./logger");
const PlatformAdapter = require("./platform-adapter");

const logger = new Logger();

class ProcessDaemon {
  constructor(scriptPath, options = {}) {
    this.scriptPath = path.resolve(scriptPath);
    this.options = options;
    this.child = null;
    this.memoryCheckInterval = null;
    this.startTime = Date.now();
    this.restartCount = 0;
    this.restartTimestamps = [];
    this.maxRestarts = 10; // 10次
    this.restartWindow = 60 * 1000; // 1分钟
    this.name = options.name || path.basename(scriptPath);
    this.pidFile = path.join(os.tmpdir(), `mypm2-${this.name}.pid`);
    this.ensureLogDir();
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
      await this.stop();

      // 重启保护：1分钟内最多重启10次
      const now = Date.now();
      this.restartTimestamps = this.restartTimestamps.filter(
        (ts) => now - ts < this.restartWindow
      );
      if (this.restartTimestamps.length >= this.maxRestarts) {
        logger.write(
          "system",
          `重启次数过多，${this.maxRestarts}次/${
            this.restartWindow / 1000
          }s，暂停自动重启`
        );
        return;
      }
      this.restartTimestamps.push(now);

      const args = [this.scriptPath];
      const envConfig =
        process.env.NODE_ENV === "production"
          ? this.options.env_production || {}
          : this.options.env || {};
      const env = {
        ...process.env,
        ...envConfig,
      };
      const outFile = fs.openSync(`./logs/${this.name}-out.log`, "a");
      const errorFile = fs.openSync(`./logs/${this.name}-error.log`, "a");
      const spawnOptions = {
        env,
        stdio: ["ignore", outFile, errorFile],
        windowsHide: true,
      };
      this.child = spawn("node", args, spawnOptions);

      this.startExitWatcher();

      await new Promise((resolve, reject) => {
        this.child.once("error", reject);
        this.child.once("spawn", () => {
          try {
            const pidPath = path.join(os.tmpdir(), `mypm2-${this.name}.pid`);
            fs.writeFileSync(pidPath, String(this.child.pid));
            resolve();
          } catch (err) {
            reject(err);
          }
        });
      });

      this.startTime = Date.now();
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
      if (this.options.max_memory_restart) {
        this.setupMemoryMonitor();
      }
      this.child.on("error", (err) => {
        logger.write("system", `进程启动失败: ${err.message}`);
      });
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
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
    }, 5000);
  }

  parseMemory(str) {
    const unitMap = {
      g: Math.pow(1024, 3),
      m: Math.pow(1024, 2),
      k: 1024,
      b: 1,
    };
    const match = str
      .trim()
      .toLowerCase()
      .match(/^(\d+)([gmkb]?)$/);
    if (!match) throw new Error("Invalid memory format");
    const value = parseInt(match[1], 10);
    const unit = match[2];
    if (unit === "g") return value * unitMap.g;
    if (unit === "m") return value * unitMap.m;
    if (unit === "k") return value * unitMap.k;
    if (unit === "b") return value;
    throw new Error("Unsupported unit");
  }

  async stop() {
    if (this.memoryCheckInterval) {
      clearInterval(this.memoryCheckInterval);
      this.memoryCheckInterval = null;
    }
    try {
      let pid;
      if (this.child && this.child.pid) {
        pid = this.child.pid;
      } else if (fs.existsSync(this.pidFile)) {
        pid = parseInt(fs.readFileSync(this.pidFile, "utf8"));
      } else {
        return;
      }
      try {
        process.kill(pid, "SIGTERM");
        if (fs.existsSync(this.pidFile)) {
          fs.unlinkSync(this.pidFile);
        }
        logger.write(
          "system",
          JSON.stringify({
            event: "process_stop",
            name: this.name,
            pid: pid,
            time: new Date().toISOString(),
          })
        );
        this.child = null;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      } catch (err) {
        if (err.code === "ESRCH") {
          if (fs.existsSync(this.pidFile)) {
            fs.unlinkSync(this.pidFile);
          }
        } else {
          throw err;
        }
      }
    } catch (err) {
      if (err.code !== "ENOENT") {
        console.error(`停止进程 ${this.name} 失败:`, err);
        throw err;
      }
    }
  }

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
    console.log("正在检查临时目录:", tempDir);
    const pidFiles = fs
      .readdirSync(tempDir)
      .filter((file) => file.startsWith("mypm2-"));
    console.log("找到的PID文件:", pidFiles);
    const processes = [];
    for (const pidFile of pidFiles) {
      try {
        const pidPath = path.join(tempDir, pidFile);
        console.log("正在检查PID文件:", pidPath);
        const pid = parseInt(fs.readFileSync(pidPath, "utf8"));
        const processInfo = PlatformAdapter.getProcessInfo(pid);
        if (PlatformAdapter.isNodeProcess(processInfo)) {
          const name = pidFile.replace("mypm2-", "").replace(".pid", "");
          const scriptPath =
            PlatformAdapter.getScriptPathFromProcessInfo(processInfo) || name;
          const daemon = new ProcessDaemon(scriptPath, {
            name,
            isRestore: true,
          });
          daemon.child = { pid };
          daemon.startTime = Date.now();
          processes.push(daemon);
        } else {
          fs.unlinkSync(pidPath);
        }
      } catch (err) {
        console.error(`处理PID文件失败: ${pidFile}`, err);
      }
    }
    return processes;
  }

  startExitWatcher() {
    if (this.exitWatcher) clearInterval(this.exitWatcher);
    this.exitWatcher = setInterval(() => {
      if (!this.child || !this.child.pid) return;
      try {
        process.kill(this.child.pid, 0);
      } catch (e) {
        logger.write(
          "system",
          `子进程退出，自动重启，时间: ${new Date().toISOString()}`
        );
        clearInterval(this.exitWatcher);
        this.exitWatcher = null;
        this.child = null;
        this.restartCount = (this.restartCount || 0) + 1;
        // 加 try-catch，避免 start 抛异常导致守护断裂
        setTimeout(() => {
          this.start().catch((err) => {
            logger.write("system", `自动重启失败: ${err.message}`);
          });
        }, 1000);
      }
    }, 2000);
  }
}

module.exports = ProcessDaemon;
