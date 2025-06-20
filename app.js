
const http = require('http');

const server = http.createServer((req, res) => {
  res.writeHead(200, {'Content-Type': 'text/plain'});
  res.end('Hello from mypm2 HTTP server\n');
  console.log(`Request received at ${new Date().toISOString()}`);
});

server.listen(3001, () => {
  console.log('HTTP server running on port 3001');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error('端口3001已被占用');
  } else {
    console.error('服务器错误:', err);
  }
  process.exit(1);
});

server.on('close', () => {
  console.log('服务器已关闭，释放端口3001');
});
