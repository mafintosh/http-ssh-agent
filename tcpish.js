var stream = require('stream');
var util = require('util');

var noop = function() {};

var Tcpish = function(opts) { // Wraps the rough parts of ssh2 streams
	stream.Duplex.call(this, opts);

	this.ondrain = noop;
	this.flushed = true;
	this.conn = null;
	this.update = noop;
	this.buffer = null;
	this.cb = noop;
	this.refed = true;
	this.destroyed = false;
	this.finished = false;
	this.ticks = 0;
	this.timeout = null;

	this.on('finish', function() {
		if (this.timeout) clearInterval(this.timeout);
		this.finished = true;
		if (this.conn) this.conn.end();
	});
};

util.inherits(Tcpish, stream.Duplex);

Tcpish.prototype.ondata = noop;
Tcpish.prototype.onend = noop;

Tcpish.prototype.onref = noop;
Tcpish.prototype.onunref = noop;

Tcpish.prototype.setNoDelay = noop;

Tcpish.prototype.ref = function() {
	if (this.refed) return;
	this.refed = true;
	this.onref();
};

Tcpish.prototype.unref = function() {
	if (!this.refed) return;
	this.refed = false;
	this.onunref();
};

Tcpish.prototype.destroy = function(err) {
	if (this.destroyed) return;
	this.destroyed = true;
	if (this.timeout) clearInterval(this.timeout);
	if (err) this.emit('error', err);
	if (this.conn) this.conn.destroy();
	this.emit('close');
};

Tcpish.prototype.setTimeout = function(ms, cb) {
	clearInterval(this.timeout);
	if (!ms) return;
	if (cb) this.on('timeout', cb);

	var prev = this.ticks;
	this.timeout = setInterval(function() {
		if (prev !== self.ticks) return prev = self.ticks;
		clearInterval(self.timeout);
		self.emit('timeout');
	}, ms);

	if (this.timeout.unref) this.timeout.unref();
};

Tcpish.prototype.connect = function(conn) {
	var self = this;

	this.ondrain = noop;
	this.flushed = false;
	this.conn = conn;

	var paused = false;
	var update = function() {
		if (self.flushed) {
			if (!paused) return;
			paused = false;
			conn.resume();
		} else {
			if (paused) return;
			paused = true;
			conn.pause();
		}
	};

	var ondrain = function() {
		var ondrain = self.ondrain;
		self.ondrain = noop;
		ondrain();
	};

	var drainOutBuffer = conn._drainOutBuffer;
	conn._drainOutBuffer = function() {
		var ret = drainOutBuffer.apply(conn, arguments);
		if (ret !== false) ondrain();
		return ret;
	};

	conn.on('drain', ondrain);

	conn.on('data', function(data) {
		self.ticks++;
		self.flushed = self.push(data);
		if (self.flushed) return;
		process.nextTick(update);
	});

	conn.on('end', function() {
		self.push(null);
	});

	conn.on('close', function() {
		self.emit('close');
	});

	conn.on('error', function(err) {
		self.emit('error', err);
	});

	this.update = update;

	if (this.buffer) {
		var buffer = this.buffer;
		var cb = this.cb;

		this.cb = noop;
		this.buffer = null;

		this.conn.write(buffer);
		cb();
	}

	if (this.finished) this.conn.end();
	if (this.destroyed) this.conn.destroy();
};

Tcpish.prototype._write = function(data, enc, cb) {
	if (!this.conn) {
		this.buffer = data;
		this.cb = cb;
		return;
	}
	this.ticks++;
	if (!this.conn.writable) return cb();
	if (this.conn.write(data) !== false) return cb();
	this.ondrain = cb;
};

Tcpish.prototype._read = function() {
	this.flushed = true;
	process.nextTick(this.update);
};

module.exports = function() {
	return new Tcpish();
};