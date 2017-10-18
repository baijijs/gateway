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