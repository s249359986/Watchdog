const os = require('os');
const { execSync, spawn } = require('child_process');

class PlatformAdapter {
  static getPsCommand(pid) {
    // Linux/macOS 通用
    return `ps -p ${pid} -o command=`;
  }

  static getProcessInfo(pid) {
    try {
      const cmd = PlatformAdapter.getPsCommand(pid);
      const output = execSync(cmd, { encoding: 'utf8' }).trim();
      return output;
    } catch (e) {
      return null;
    }
  }

  static isNodeProcess(processInfo) {
    return processInfo && processInfo.includes('node');
  }

  static getScriptPathFromProcessInfo(processInfo) {
    if (!processInfo) return '';
    const args = processInfo.split(/\s+/);
    return args.find(arg => arg.endsWith('.js')) || '';
  }

  static tailLogFile(logFile, onData, onClose) {
    const tail = spawn('tail', ['-f', logFile]);
    tail.stdout.on('data', onData);
    tail.on('close', onClose);
    return tail;
  }
}

module.exports = PlatformAdapter;