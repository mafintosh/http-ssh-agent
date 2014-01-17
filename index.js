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
	return key && key.toString().toLowerCase().indexOf('encrypted') > -1;
};

var agent = function(host, opts) {
	if (typeof host === 'object' && host) return agent(null, host);
	if (!opts) opts = {};

	var connectTimeout = typeof opts.timeout === 'number' ? opts.timeout : 15000;
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

	var conn;
	var verified = false;
	var fingerprint;

	var connect = thunky(function loop(cb) {
		conn = new Connection();

		opts.hostHash = 'md5';
		opts.hostVerifier = function(hash) {
			fingerprint = hash;

			if (!opts.fingerprint) return true;
			if (fingerprint === opts.fingerprint) return true;

			conn.emit('error', new Error('Host could not be verified'));
			return false;
		};

		var update = function() {
			var sock = conn._sock;
			var pinger = conn._pinger;

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
			cb(null, conn, update);
		});

		var onverify = function(err) {
			if (err) return done(err);
			opts.fingerprint = fingerprint;
			done();
		};

		conn.on('ready', function() {
			if (fingerprint === opts.fingerprint) return done();
			if (!a.emit('verify', fingerprint, onverify)) done();
		});

		conn.on('error', function(err) {
			conn.end();
			done(err);
		});

		conn.on('close', function() {
			connect = thunky(loop);
			done(new Error('Connection closed'));
		});

		if (typeof opts.privateKey !== 'string' || opts.privateKey.indexOf('\n') > -1) return conn.connect(opts);

		fs.readFile(opts.privateKey, function(_, buf) {
			opts.privateKey = buf;
			conn.connect(opts);
		});
	});

	a.createConnection = function(opts) {
		var socket = tcpish(hwm ? {highWaterMark:hwm} : {});

		var destroy = function() {
			if (conn && conn._sock) conn._sock.destroy();
			else if (conn) conn.end();
			socket.destroy();
		};

		var timeout = connectTimeout && setTimeout(destroy, connectTimeout);
		if (timeout && timeout.unref) timeout.unref();

		connect(function(err, con, update) {
			if (err) {
				clearTimeout(timeout);
				return socket.destroy(err);
			}

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
				clearTimeout(timeout);

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