const fs = require('fs');
const path = require('path');

class Logger {
  constructor() {
    this.logDir = path.join(process.cwd(), 'logs');
    this.ensureLogDir();
  }

  ensureLogDir() {
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
  }

  write(type, message) {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] ${message}\n`;
    const logFile = this.getLogFile(type);

    try {
      fs.appendFileSync(logFile, logEntry);
    } catch (err) {
      console.error('写入日志失败:', err);
    }
  }

  read(type) {
    const logFile = this.getLogFile(type);
    try {
      if (fs.existsSync(logFile)) {
        return fs.readFileSync(logFile, 'utf8');
      }
      return null;
    } catch (err) {
      console.error('读取日志失败:', err);
      return null;
    }
  }

  getLogFile(type) {
    switch (type) {
      case 'stdout':
        return path.join(this.logDir, 'out.log');
      case 'stderr':
        return path.join(this.logDir, 'error.log');
      case 'system':
      default:
        return path.join(this.logDir, 'system.log');
    }
  }

  getAppLogFile(appName, type) {
    switch (type) {
      case 'out':
      case 'stdout':
        return path.join(this.logDir, `${appName}-out.log`);
      case 'err':
      case 'stderr':
        return path.join(this.logDir, `${appName}-error.log`);
      default:
        return null;
    }
  }

  readAppLog(appName, type) {
    const logFile = this.getAppLogFile(appName, type);
    if (!logFile) return null;

    try {
      if (fs.existsSync(logFile)) {
        return fs.readFileSync(logFile, 'utf8');
      }
      return null;
    } catch (err) {
      console.error('读取应用日志失败:', err);
      return null;
    }
  }
}

module.exports = Logger;