// Loaded with NODE_OPTIONS="--import <this file>" for measurement: refuses agent and network
// executables, connections off this machine, and the default production port, in every Node process.
import { DEFAULT_SERVER_PORT } from '../../packages/contract/dist/default-server.js';
import childProcess from "node:child_process";
import net from "node:net";
import { basename } from "node:path";
import { syncBuiltinESMExports } from "node:module";

const refused = ["codex", "claude", "osascript", "curl", "wget", "ssh", "alpacawork"];
const deny = (kind, value) => { throw new Error(`perf guard refused ${kind}: ${value}`); };
for (const key of ["spawn", "spawnSync", "execFile", "execFileSync"]) {
  const original = childProcess[key];
  childProcess[key] = function (file, ...rest) {
    if (refused.includes(basename(String(file)))) deny("executable", file);
    return original.call(this, file, ...rest);
  };
}
for (const key of ["exec", "execSync"]) {
  const original = childProcess[key];
  childProcess[key] = function (command, ...rest) {
    if (new RegExp(`(^|[\\s/;|&])(${refused.join("|")})([\\s;|&]|$)`).test(command)) deny("shell", command);
    return original.call(this, command, ...rest);
  };
}
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const host = typeof first === "object" ? first.host : typeof args[1] === "string" ? args[1] : undefined;
  const port = typeof first === "object" ? first.port : first;
  if (host && !["127.0.0.1", "localhost", "::1", "[::1]"].includes(host)) deny("host", host);
  if (Number(port) === DEFAULT_SERVER_PORT) deny("port", port);
  return connect.apply(this, args);
};
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  const port = typeof args[0] === "object" ? args[0].port : args[0];
  if (Number(port) === DEFAULT_SERVER_PORT) deny("listen port", port);
  return listen.apply(this, args);
};
syncBuiltinESMExports();
