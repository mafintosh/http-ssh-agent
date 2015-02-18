var tape = require('tape')
var username = require('username')
var http = require('http')
var concat = require('concat-stream')
var agent = require('./')

tape('can connect', function (t) {
  var verified = false

  var server = http.createServer(function (req, res) {
    res.statusCode = 204
    res.end()
  })

  server.listen(0, function () {
    username(function (err, name) {
      t.error(err, 'no error')

      var a = agent(name + '@localhost')

      a.on('verify', function (fingerprint, cb) {
        verified = true
        cb()
      })

      var req = http.request({
        method: 'GET',
        port: server.address().port,
        host: 'localhost',
        agent: a
      })

      req.end()
      req.on('response', function (res) {
        t.ok(verified, 'verified')
        t.same(res.statusCode, 204, 'status code forward')
        t.end()
        res.resume()
        server.close()
      })
    })
  })
})

tape('can connect more than once', function (t) {
  var verified = false

  var server = http.createServer(function (req, res) {
    req.pipe(res)
  })

  server.listen(0, function () {
    username(function (err, name) {
      t.error(err, 'no error')

      var a = agent(name + '@localhost')

      a.on('verify', function (fingerprint, cb) {
        verified = true
        cb()
      })

      var loop = function (i) {
        var req = http.request({
          method: 'POST',
          port: server.address().port,
          host: 'localhost',
          agent: a
        })

        req.end('body-' + i)
        req.on('response', function (res) {
          res.pipe(concat(function (body) {
            t.ok(verified, 'verified')
            t.same(res.statusCode, 200, 'ok status code')
            t.same(body.toString(), 'body-' + i, 'echoed body')

            if (i < 5) return loop(i + 1)

            server.close()
            t.end()
          }))
        })
      }

      loop(0)
    })
  })
})

tape('can connect more than once in parallel', function (t) {
  var verified = false

  var server = http.createServer(function (req, res) {
    req.pipe(res)
  })

  server.listen(0, function () {
    username(function (err, name) {
      t.error(err, 'no error')

      var a = agent(name + '@localhost')
      var missing = 5

      a.on('verify', function (fingerprint, cb) {
        verified = true
        cb()
      })

      var loop = function (i) {
        var req = http.request({
          method: 'POST',
          port: server.address().port,
          host: 'localhost',
          agent: a
        })

        req.end('body-' + i)
        req.on('response', function (res) {
          res.pipe(concat(function (body) {
            t.ok(verified, 'verified')
            t.same(res.statusCode, 200, 'ok status code')
            t.same(body.toString(), 'body-' + i, 'echoed body')

            if (--missing) return

            server.close()
            t.end()
          }))
        })
      }

      for (var i = 0; i < 5; i++) loop(i)
    })
  })
})
