if (process.platform === 'win32') {
  const origKill = process.kill;
  process.kill = function (pid, sig) {
    if (typeof pid === 'number' && pid < 0) {
      const targetPid = -pid;
      try {
        require('child_process').execSync(`taskkill /F /T /PID ${targetPid}`, { stdio: 'ignore' });
      } catch (e) {}

      // On Windows, child processes spawned through npm/sh may detach from the parent tree.
      // Clean up any listening server instances on 4001..4010.
      try {
        const netstat = require('child_process').execSync('netstat -ano -p tcp', { encoding: 'utf8' });
        for (const line of netstat.split('\n')) {
          if (line.includes('LISTENING') && /:400[1-9]\b/.test(line)) {
            const parts = line.trim().split(/\s+/);
            const listenPid = Number(parts[parts.length - 1]);
            if (listenPid && listenPid !== process.pid) {
              try {
                require('child_process').execSync(`taskkill /F /T /PID ${listenPid}`, { stdio: 'ignore' });
              } catch (e) {}
            }
          }
        }
      } catch (e) {}
      return true;
    }
    return origKill.apply(this, arguments);
  };
}
