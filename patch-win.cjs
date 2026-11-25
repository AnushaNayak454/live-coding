if (process.platform === 'win32') {
  const cp = require('child_process');
  const pidToPort = new Map();

  const origSpawn = cp.spawn;
  cp.spawn = function (cmd, args, opts) {
    const child = origSpawn.apply(this, arguments);
    if (opts && opts.env && opts.env.PORT) {
      pidToPort.set(child.pid, Number(opts.env.PORT));
    }
    return child;
  };

  const origKill = process.kill;
  process.kill = function (pid, sig) {
    if (typeof pid === 'number' && pid < 0) {
      const targetPid = -pid;
      const targetPort = pidToPort.get(targetPid);

      // Kill the process tree of targetPid
      try {
        cp.execSync(`taskkill /F /T /PID ${targetPid}`, { stdio: 'ignore' });
      } catch (e) {}

      // If we know the exact port of this instance, kill only the process listening on this port
      if (targetPort) {
        try {
          const netstat = cp.execSync('netstat -ano -p tcp', { encoding: 'utf8' });
          for (const line of netstat.split('\n')) {
            if (line.includes('LISTENING') && line.includes(`:${targetPort}`)) {
              const parts = line.trim().split(/\s+/);
              const listenPid = Number(parts[parts.length - 1]);
              if (listenPid && listenPid !== process.pid) {
                try {
                  cp.execSync(`taskkill /F /T /PID ${listenPid}`, { stdio: 'ignore' });
                } catch (e) {}
              }
            }
          }
        } catch (e) {}
      }
      return true;
    }
    return origKill.apply(this, arguments);
  };
}
