'use strict';
function createShutdown({onStart = () => {}, stop, flush, exit, onError}) {
  let pending = null;
  return {
    request() {
      if (pending) return pending;
      pending = Promise.resolve().then(async () => {
        onStart();
        await stop();
        await flush();
        exit();
        return true;
      }).catch(error => {
        pending = null;
        onError(error);
        return false;
      });
      return pending;
    }
  };
}
module.exports = {createShutdown};
