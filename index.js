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
	this.ref = true;

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

Socket.prototype.ref = function() {
	this.ref = false;
	if (this.onref) this.onref();
};

Socket.prototype.unref = function() {
	this.ref = true;
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


var agent = function(host, opts) {
	if (typeof host === 'object' && host) return agent(null, host);
	if (!opts) opts = {};

	if (host) {
		var parts = host.match(/^(?:([^@]+)@)?([^:]+)(?::(\d+))?$/);
		opts.username = parts[1] || 'root';
		opts.host = parts[2];
		opts.port = parseInt(parts[3] || 22, 10);
	}

	opts.privateKey = opts.key || opts.privateKey || path.join('~', '.ssh', 'id_rsa');

	var hwm = opts.highWaterMark;
	var a = new http.Agent();
	var refs = 0;

	var verified = true;
	var connect = thunky(function loop(cb) {
		if (!verified) return cb(new Error('Host validation failed'));

		var c = new Connection();
		var fingerprint;

		var verify = function(hash) {
			fingerprint = hash;
			return verified;
		};

		var done = once(function(err) {
			if (err) return cb(err);

			c.on('close', function() {
				connect = thunky(loop);
			});

			cb(null, c);
		});

		c.on('error', done);
		c.on('ready', function() {
			if (!a.listeners('verify').length) return done();
			a.emit('verify', fingerprint, function(err) {
				if (!err) return done();
				verified = false;
				done(err);
			});
		});

		var ready = function() {
			if (!opts.hostHash) opts.hostHash = 'sha1';
			if (!opts.hostVerifier) opts.hostVerifier = verify;
			c.connect(opts);
		};

		if (Buffer.isBuffer(opts.privateKey)) return ready();

		fs.readFile(opts.privateKey.replace(/^~/, HOME), function(err, key) {
			if (err) return done(err);
			opts.privateKey = key;
			ready();
		});
	});

	a.createConnection = function(opts) {
		var socket = new Socket(hwm ? {highWaterMark:hwm} : {});

		connect(function(err, con) {
			if (err) return socket.destroy(err);

			if (socket.ref) refs++;

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

			var unref = function() {
				refs--;
				update();
			};

			socket.onref = socket.onunref = update;
			update();

			con.forwardOut('127.0.0.1', 8000, opts.host, opts.port, function(err, stream) {
				if (err) {
					socket.destroy(err);
					unref();
				} else {
					pump(socket.input, stream, socket.output, unref);
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