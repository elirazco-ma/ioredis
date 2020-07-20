"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
let currentLogger = null;
function setLogger(theLogger) {
    if (theLogger && !currentLogger) {
        currentLogger = theLogger;
    }
}
exports.setLogger = setLogger;
function getLogger() {
    return currentLogger;
}
exports.getLogger = getLogger;
