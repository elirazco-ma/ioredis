let currentLogger = null;

export function setLogger(theLogger) {
  if (theLogger && !currentLogger) {
    currentLogger = theLogger;
  }
}

export function getLogger() {
  return currentLogger;
}
