const fs = require('fs');
const path = require('path');
const source = path.join(__dirname, '..', 'node_modules', 'socket.io-client', 'dist', 'socket.io.min.js');
const target = path.join(__dirname, '..', 'www', 'socket.io.min.js');
if (!fs.existsSync(source)) {
  console.error('socket.io-client is missing. Run npm install first.');
  process.exit(1);
}
fs.copyFileSync(source, target);
console.log('Copied Socket.IO browser client into www/.');
