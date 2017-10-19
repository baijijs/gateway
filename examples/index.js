'use strict';

const baiji = require('baiji');

const app = baiji('app');

app.define('index', {
  description: 'index api',
  route: { path: '/', verb: 'get' }
}, function(ctx, next) {
  return ctx.done({ message: 'index api called' }, next);
});

app.define('show', {
  description: 'show api',
  route: { path: '/:id', verb: 'get' }
}, function(ctx, next) {
  return ctx.done({ message: 'show api called with id ' + ctx.args.id }, next);
});

app.define('update', {
  description: 'update api',
  route: { path: '/:id', verb: 'put' }
}, function(ctx, next) {
  return new Promise(function(resolve) {
    setTimeout(function() {
      resolve(ctx.done({ message: 'update api called with id ' + ctx.args.id }, next));
    }, 1000);
  });
});

// add baiji-gateway plugin
app.plugin(require('../'), { max: 5 });

app.listen(3003);

// Start server
// DEBUG=baiji:Adapter node examples

/**
 * Curl request example

curl -X POST localhost:3003/gateway \
-H 'Content-Type: application/json' \
-d '{
  "index": { "method": "app.index", "dependencies": ["update"] },
  "update": { "method": "app.update", "params": { "id": 1 }, "dependencies": ["show"] },
  "show": { "method": "app.show", "params": { "id": 1 } }
}'

 */