"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const command_1 = require("./command");
const utils_1 = require("./utils");
const RedisParser = require("redis-parser");
const SubscriptionSet_1 = require("./SubscriptionSet");
const { getLogger } = require("../logger");
const debug = utils_1.Debug("dataHandler");
class DataHandler {
    constructor(redis, parserOptions) {
        this.redis = redis;
        const parser = new RedisParser({
            stringNumbers: parserOptions.stringNumbers,
            returnBuffers: !parserOptions.dropBufferSupport,
            returnError: (err) => {
                this.returnError(err);
            },
            returnFatalError: (err) => {
                this.returnFatalError(err);
            },
            returnReply: (reply) => {
                this.returnReply(reply);
            },
        });
        this.successReplyCounter = 0;
        this.errorReplyCounter = 0;
        this.fatalErrorReplyCounter = 0;
        redis.stream.on("data", (data) => {
            parser.execute(data);
        });
    }
    returnFatalError(err) {
        this.fatalErrorReplyCounter++;
        err.message += ". Please report this.";
        this.redis.recoverFromFatalError(err, err, { offlineQueue: false });
        getLogger().error("REDIS FATAL ERROR Got reply with lengths", {
            successReplyCounter: this.successReplyCounter,
            errorReplyCounter: this.errorReplyCounter,
            fatalErrorReplyCounter: this.fatalErrorReplyCounter,
            commandsCounter: this.redis.commandsCounter,
            commandsFlushed: this.redis.commandsFlushed
        });
        if (this.successReplyCounter + this.errorReplyCounter + this.fatalErrorReplyCounter + this.redis.commandQueue.length + this.redis.commandsFlushed != this.redis.commandsCounter) {
            getLogger().error("REDIS FATAL ERROR UNEXPECTED QUEUES LENGTHS", {
                successReplyCounter: this.successReplyCounter,
                errorReplyCounter: this.errorReplyCounter,
                fatalErrorReplyCounter: this.fatalErrorReplyCounter,
                commandsCounter: this.redis.commandsCounter,
                commandsFlushed: this.redis.commandsFlushed
            });
        }
    }
    returnError(err) {
        this.errorReplyCounter++;
        const item = this.shiftCommand(err);
        getLogger().error("REDIS ERROR Got reply with lengths", {
            successReplyCounter: this.successReplyCounter,
            errorReplyCounter: this.errorReplyCounter,
            fatalErrorReplyCounter: this.fatalErrorReplyCounter,
            commandsCounter: this.redis.commandsCounter,
            commandsFlushed: this.redis.commandsFlushed
        });
        if (this.successReplyCounter + this.errorReplyCounter + this.fatalErrorReplyCounter + this.redis.commandQueue.length + this.redis.commandsFlushed != this.redis.commandsCounter) {
            getLogger().error("REDIS ERROR UNEXPECTED QUEUES LENGTHS", {
                successReplyCounter: this.successReplyCounter,
                errorReplyCounter: this.errorReplyCounter,
                fatalErrorReplyCounter: this.fatalErrorReplyCounter,
                commandsCounter: this.redis.commandsCounter,
                commandsFlushed: this.redis.commandsFlushed
            });
        }
        if (!item) {
            return;
        }
        err.command = {
            name: item.command.name,
            args: item.command.args,
        };
        this.redis.handleReconnection(err, item);
    }
    returnReply(reply) {
        this.successReplyCounter++;
        if (this.handleMonitorReply(reply)) {
            return;
        }
        if (this.handleSubscriberReply(reply)) {
            return;
        }
        const item = this.shiftCommand(reply);
        getLogger().error("REDIS Got reply with lengths", {
            successReplyCounter: this.successReplyCounter,
            errorReplyCounter: this.errorReplyCounter,
            fatalErrorReplyCounter: this.fatalErrorReplyCounter,
            commandsCounter: this.redis.commandsCounter,
            commandsFlushed: this.redis.commandsFlushed
        });
        if (this.successReplyCounter + this.errorReplyCounter + this.fatalErrorReplyCounter + this.redis.commandQueue.length + this.redis.commandsFlushed != this.redis.commandsCounter) {
            getLogger().error("REDIS UNEXPECTED QUEUES LENGTHS", {
                successReplyCounter: this.successReplyCounter,
                errorReplyCounter: this.errorReplyCounter,
                fatalErrorReplyCounter: this.fatalErrorReplyCounter,
                commandsCounter: this.redis.commandsCounter,
                commandsFlushed: this.redis.commandsFlushed
            });
        }
        if (!item) {
            return;
        }
        if (command_1.default.checkFlag("ENTER_SUBSCRIBER_MODE", item.command.name)) {
            this.redis.condition.subscriber = new SubscriptionSet_1.default();
            this.redis.condition.subscriber.add(item.command.name, reply[1].toString());
            if (!fillSubCommand(item.command, reply[2])) {
                this.redis.commandQueue.unshift(item);
            }
        }
        else if (command_1.default.checkFlag("EXIT_SUBSCRIBER_MODE", item.command.name)) {
            if (!fillUnsubCommand(item.command, reply[2])) {
                this.redis.commandQueue.unshift(item);
            }
        }
        else {
            item.command.resolve(reply);
        }
    }
    handleSubscriberReply(reply) {
        if (!this.redis.condition.subscriber) {
            return false;
        }
        const replyType = Array.isArray(reply) ? reply[0].toString() : null;
        debug('receive reply "%s" in subscriber mode', replyType);
        switch (replyType) {
            case "message":
                if (this.redis.listeners("message").length > 0) {
                    // Check if there're listeners to avoid unnecessary `toString()`.
                    this.redis.emit("message", reply[1].toString(), reply[2].toString());
                }
                this.redis.emit("messageBuffer", reply[1], reply[2]);
                break;
            case "pmessage": {
                const pattern = reply[1].toString();
                if (this.redis.listeners("pmessage").length > 0) {
                    this.redis.emit("pmessage", pattern, reply[2].toString(), reply[3].toString());
                }
                this.redis.emit("pmessageBuffer", pattern, reply[2], reply[3]);
                break;
            }
            case "subscribe":
            case "psubscribe": {
                const channel = reply[1].toString();
                this.redis.condition.subscriber.add(replyType, channel);
                const item = this.shiftCommand(reply);
                if (!item) {
                    return;
                }
                if (!fillSubCommand(item.command, reply[2])) {
                    this.redis.commandQueue.unshift(item);
                }
                break;
            }
            case "unsubscribe":
            case "punsubscribe": {
                const channel = reply[1] ? reply[1].toString() : null;
                if (channel) {
                    this.redis.condition.subscriber.del(replyType, channel);
                }
                const count = reply[2];
                if (count === 0) {
                    this.redis.condition.subscriber = false;
                }
                const item = this.shiftCommand(reply);
                if (!item) {
                    return;
                }
                if (!fillUnsubCommand(item.command, count)) {
                    this.redis.commandQueue.unshift(item);
                }
                break;
            }
            default: {
                const item = this.shiftCommand(reply);
                if (!item) {
                    return;
                }
                item.command.resolve(reply);
            }
        }
        return true;
    }
    handleMonitorReply(reply) {
        if (this.redis.status !== "monitoring") {
            return false;
        }
        const replyStr = reply.toString();
        if (replyStr === "OK") {
            // Valid commands in the monitoring mode are AUTH and MONITOR,
            // both of which always reply with 'OK'.
            // So if we got an 'OK', we can make certain that
            // the reply is made to AUTH & MONITO.
            return false;
        }
        // Since commands sent in the monitoring mode will trigger an exception,
        // any replies we received in the monitoring mode should consider to be
        // realtime monitor data instead of result of commands.
        const len = replyStr.indexOf(" ");
        const timestamp = replyStr.slice(0, len);
        const argindex = replyStr.indexOf('"');
        const args = replyStr
            .slice(argindex + 1, -1)
            .split('" "')
            .map((elem) => elem.replace(/\\"/g, '"'));
        const dbAndSource = replyStr.slice(len + 2, argindex - 2).split(" ");
        this.redis.emit("monitor", timestamp, args, dbAndSource[1], dbAndSource[0]);
        return true;
    }
    shiftCommand(reply) {
        const item = this.redis.commandQueue.shift();
        if (!item) {
            const message = "Command queue state error. If you can reproduce this, please report it.";
            const error = new Error(message +
                (reply instanceof Error
                    ? ` Last error: ${reply && reply.message}`
                    : ` Last reply: ${reply && reply.toString()}`));
            this.redis.emit("error", error);
            return null;
        }
        return item;
    }
}
exports.default = DataHandler;
function fillSubCommand(command, count) {
    // TODO: use WeakMap here
    if (typeof command.remainReplies === "undefined") {
        command.remainReplies = command.args.length;
    }
    if (--command.remainReplies === 0) {
        command.resolve(count);
        return true;
    }
    return false;
}
function fillUnsubCommand(command, count) {
    if (typeof command.remainReplies === "undefined") {
        command.remainReplies = command.args.length;
    }
    if (command.remainReplies === 0) {
        if (count === 0) {
            command.resolve(count);
            return true;
        }
        return false;
    }
    if (--command.remainReplies === 0) {
        command.resolve(count);
        return true;
    }
    return false;
}
