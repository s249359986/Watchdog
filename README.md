# watchdog

一个简单的 Node.js 进程守护与管理工具，支持跨平台（macOS、Linux），可全局安装后通过命令行 `wd` 使用。

## 安装

```bash
npm install -g .
# 或发布到 npm 后
npm install -g watchdog
```

## 基本用法

### 启动应用

```bash
wd start app.js
```

### 使用配置文件批量启动

```bash
wd start -c ./start.config.js
```

### 查看所有运行中的应用

```bash
wd list
```

### 停止所有守护的进程

```bash
wd stop
```

### 查看系统日志

```bash
wd logs
```

### 查看指定应用日志

```bash
wd logs app.js out      # 查看标准输出日志
wd logs app.js err      # 查看错误日志
```

### 实时查看日志

```bash
wd logs app.js out -f
```

### 查看日志最后 N 行

```bash
wd logs app.js out -n 50
```

## 其他说明

- 日志文件默认保存在 `logs/` 目录下。
- 进程 PID 文件保存在系统临时目录。
- 支持 macOS、Linux（CentOS/Ubuntu）等主流平台。

## LICENSE

MIT