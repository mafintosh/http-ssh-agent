var http = require('http');
var Connection = require('ssh2');
var eos = require('end-of-stream');
var thunky = require('thunky');
var once = require('once');
var fs = require('fs');
var path = require('path');
var net = require('net');
var tcpish = require('./tcpish');

var HOME = process.env.HOME || process.env.USERPROFILE;
var ID_RSA;

try {
	ID_RSA = fs.readFileSync(path.join(HOME, '.ssh', 'id_rsa'));
} catch (err) {
	ID_RSA = null;
}

var noop = function() {};

var encrypted = function(key) {
	return key && key.toString().indexOf('encrypted') > -1;
};

var agent = function(host, opts) {
	if (typeof host === 'object' && host) return agent(null, host);
	if (!opts) opts = {};

	var hwm = opts.highWaterMark;
	var a = new http.Agent();
	var refs = 0;

	if (host) {
		var parts = host.match(/^(?:([^@]+)@)?([^:]+)(?::(\d+))?$/);
		opts.username = parts[1] || 'root';
		opts.host = parts[2];
		opts.port = parseInt(parts[3] || 22, 10);
	}

	opts.privateKey = opts.key || opts.privateKey || (!encrypted(ID_RSA) || opts.passphrase ? ID_RSA : null);
	opts.agent = opts.agent !== false && opts.agent || process.env.SSH_AUTH_SOCK;

	var verified = false;
	var connect = thunky(function loop(cb) {
		var c = new Connection();
		var fingerprint;

		opts.hostHash = 'md5';
		opts.hostVerifier = function(hash) {
			fingerprint = hash;

			if (verified || !opts.verify) return true;
			if (fingerprint === opts.verify) return verified = true;

			c.emit('error', new Error('Host could not be verified'));
			return false;
		};

		var update = function() {
			var sock = c._sock;
			var pinger = c._pinger;

			if (refs) {
				if (sock && sock.ref) sock.ref();
				if (pinger && pinger.ref) pinger.ref();
			} else {
				if (sock && sock.unref) sock.unref();
				if (pinger && pinger.unref) pinger.unref();
			}
		};

		var done = once(function(err) {
			if (err) return cb(err);
			verified = true;
			cb(null, c, update);
		});

		c.on('ready', function() {
			if (verified) return done();
			if (!c.emit('verify', fingerprint, done)) done();
		});

		c.on('error', function(err) {
			c.end();
			done(err);
		});

		c.on('close', function() {
			connect = thunky(loop);
		});

		if (typeof opts.privateKey !== 'string' || opts.privateKey.indexOf('\n') > -1) return c.connect(opts);

		fs.readFile(opts.privateKey, function(_, buf) {
			opts.privateKey = buf;
			c.connect(opts);
		});
	});

	a.createConnection = function(opts) {
		var socket = tcpish(hwm ? {highWaterMark:hwm} : {});

		connect(function(err, con, update) {
			if (err) return socket.destroy(err);

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
					socket.connect(stream);
					eos(stream, function() {
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