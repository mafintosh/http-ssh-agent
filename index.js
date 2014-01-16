var http = require('http');
var Connection = require('ssh2');
var thunky = require('thunky');
var pump = require('pump');
var once = require('once');
var stream = require('stream');
var fs = require('fs');
var path = require('path');
var net = require('net');
var util = require('util');

var HOME = process.env.HOME || process.env.USERPROFILE;
var noop = function() {};

var Socket = function(opts) {
	var self = this;

	stream.Duplex.call(this, opts);

	this.input = new stream.PassThrough();
	this.output = new stream.PassThrough();
	this.destroyed = false;
	this.reading = false;
	this.refed = true;

	this.output.on('readable', function() {
		if (self.reading) self._read();
	});

	this.output.on('end', function() {
		self.push(null);
	});

	this.on('finish', function() {
		self.input.end();
	});

	this.input.destroy = this.output.destroy = this.destroy.bind(this);
};

util.inherits(Socket, stream.Duplex);

Socket.prototype.onunref = Socket.prototype.onref = Socket.prototype.ondata = Socket.prototype.onend = noop;

Socket.prototype.setNoDelay = noop;

Socket.prototype.ref = function() {
	if (this.refed) return;
	this.refed = true;
	if (this.onref) this.onref();
};

Socket.prototype.unref = function() {
	if (!this.refed) return;
	this.refed = false;
	if (this.onunref) this.onunref();
};

Socket.prototype.destroy = function(err) {
	if (this.destroyed) return;
	this.destroyed = true;

	var self = this;
	process.nextTick(function() {
		if (err) self.emit('error', err);
		self.emit('close');
		self.input.emit('close');
		self.output.emit('close');
	});
};

Socket.prototype._write = function(data, enc, cb) {
	return this.input.write(data, enc, cb);
};

Socket.prototype._read = function() {
	this.reading = false;
	var data = this.output.read();
	if (data) this.push(data);
	else this.reading = true;
};

var SSHWrap = function(conn) { // Wraps the rough parts of ssh2 streams
	var self = this;

	this.conn = conn;
	this.ondrain = noop;
	this.flushed = false;

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

	conn.on('drain', function() {
		var ondrain = self.ondrain;
		self.ondrain = noop;
		ondrain();
	});

	conn.on('data', function(data) {
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

	this.on('finish', function() {
		conn.end();
	});

	stream.Duplex.call(this);
};

util.inherits(SSHWrap, stream.Duplex);

SSHWrap.prototype._write = function(data, enc, cb) {
	if (!this.conn.writable) return cb();
	if (this.conn.write(data) !== false) return cb();
	this.ondrain = cb;
};

SSHWrap.prototype._read = function() {
	this.flushed = true;
	process.nextTick(this.update);
};

var toConnect = function(host, opts) {
	if (host) {
		var parts = host.match(/^(?:([^@]+)@)?([^:]+)(?::(\d+))?$/);
		opts.username = parts[1] || 'root';
		opts.host = parts[2];
		opts.port = parseInt(parts[3] || 22, 10);
	}

	opts.privateKey = opts.key || opts.privateKey || path.join('~', '.ssh', 'id_rsa');
	opts.agent = opts.agent !== false && opts.agent || process.env.SSH_AUTH_SOCK;

	return function() {
		var c = new Connection();

		if (Buffer.isBuffer(opts.privateKey)) return ready();

		fs.readFile(opts.privateKey.replace(/^~/, HOME), function(err, key) {
			if (err) return c.connect(opts);
			opts.privateKey = key;
			c.connect(opts);
		});

		return c;
	};
};

var agent = function(host, opts) {
	if (typeof host === 'object' && host) return toConnect(null, host);
	if (!opts) opts = {};

	var create = typeof host === 'function' ? host : toConnect(host, opts);
	var hwm = opts.highWaterMark;
	var a = new http.Agent();
	var refs = 0;

	var connect = thunky(function loop(cb) {
		var c = create();

		var done = once(function(err) {
			if (err) return cb(err);
			cb(null, c);
		});

		c.on('ready', done);

		c.on('error', function(err) {
			c.end();
			done(err);
		});

		c.on('close', function() {
			connect = thunky(loop);
		});
	});

	a.createConnection = function(opts) {
		var socket = new Socket(hwm ? {highWaterMark:hwm} : {});

		connect(function(err, con) {
			if (err) return socket.destroy(err);

			var update = function() {
				var sock = con._sock;
				var pinger = con._pinger;

				if (refs) {
					if (sock && sock.ref) sock.ref();
					if (pinger && pinger.ref) pinger.ref();
				} else {
					if (sock && sock.unref) sock.unref();
					if (pinger && pinger.unref) pinger.unref();
				}
			};

			socket.onref = function() {
				refs++;
				update();
			};

			socket.onunref = function() {
				refs--;
				update();
			};

			if (socket.refed) socket.onref();
			else update();

			con.forwardOut('127.0.0.1', 8000, opts.host, opts.port, function(err, stream) {
				if (err) {
					socket.destroy(err);
					socket.unref();
				} else {
					pump(socket.input, new SSHWrap(stream), socket.output, function() {
						socket.unref();
					});
				}
			});
		});

		socket.on('data', function(data) {
			if (socket.ondata) socket.ondata(data, 0, data.length);
		});

		socket.on('end', function() {
			if (socket.onend) socket.onend();
		});

		return socket;
	};

	return a;
};

module.exports = agent;