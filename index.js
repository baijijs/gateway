'use strict';

// allowedAPIs: Whitelist api list
// forbiddenAPIs: Blacklist api list
// max: Maximum process quantity

// Request body defination
// {
//   articles: {
//     method: 'muse.articles.index',
//     params: 'any',
//     dependencies: [
//       'create'
//     ]
//   },
//   create: {
//     method: 'muse.articles.index',
//     params: 'any',
//     dependencies: []
//   }
// }

const GATEWAY_METHOD_NAME = '__gateway__';
const _ = require('lodash');

module.exports = function baijiGatewayPlugin(app, options) {
  options = options || {};
  options.max = options.max || 5;
  options.allowedAPIs = options.allowedAPIs || [];
  options.forbiddenAPIs = options.forbiddenAPIs || [];
  options.onError = options.onError;

  const ALL_METHODS = {};
  app.composedMethods().map(method => {
    // Ignore gateway method
    if (method.name === GATEWAY_METHOD_NAME) return;

    ALL_METHODS[method.fullName()] = method;
  });

  function invokeApiByName(name, ctx, args) {
    let method = ALL_METHODS[name];

    let newCtx = ctx.adapter.Context.create(
      ctx.request,
      ctx.response,
      method,
      ctx.options
    );

    newCtx.setArgs(args || {});
    newCtx._isMock = true;

    return new Promise(function(resolve, reject) {
      method.invoke(newCtx, function(res) {
        if (res.error) return reject(res.error);
        resolve(res.result);
      });
    });
  }

  // Cast val to array
  function castToArray(val) {
    val = val || [];
    val = Array.isArray(val) ? val : [val];
    return val;
  }

  // Execute apis by specific orders
  // [promise0, [promise1, promise2], promise3, promise4]
  function execStack(stack) {
    stack = castToArray(stack);

    let next = stack.shift();
    let promise = Promise.resolve();

    if (next) {
      if (Array.isArray(next)) {
        promise = Promise.all(next.map(fn => fn()));
      } else {
        promise = next();
      }

      return promise.then(() => {
        return execStack(stack);
      });
    } else {
      return promise;
    }
  }

  function executeApis(schema, ctx) {
    schema = schema || {};

    let result = {};

    let stack = _(schema).map(function(api, name) {
      api = api || {};
      api.dependencies = castToArray(api.dependencies);
      return { name, api };
    })

    // Compare api priority
    .tap(function(res) {
      return res.sort(function(a, b) {
        if (a.api.dependencies.indexOf(b.name) > -1) return 1;
        if (b.api.dependencies.indexOf(a.name) > -1) return -1;
        return 0;
      });
    })

    // Group apis by dependencies
    .tap(function(res) {
      let group = [];
      let order = [];
      res.map(item => {
        let key = item.api.dependencies.map(String).join('.');
        if (order.indexOf(key) === -1) order.push(key);
        let index = order.indexOf(key);
        if (!group[index]) group[index] = [];
        group[index].push(item);
      });
      return group;
    })

    // Convert to executeable stack
    .map(function(item) {
      item = castToArray(item);
      return item.map(i => {
        return function apiInvoker() {
          return invokeApiByName(i.api.method, ctx, i.api.params)
            .then(res => {
              result[i.name] = res;
            }).catch(err => {
              result[i.name] = err;
            });
        };
      });
    }).value();

    return execStack(stack).then(() => {
      return result;
    });
  }

  // Validate schema and return proper error
  function validateSchema(schema) {
    schema = schema || {};

    let apisCount = _.keys(schema).length;

    // Check whether the apis count is within tolerable range
    if (apisCount === 0) return new Error('Invalid Request Body');
    if (apisCount > options.max) return new Error('Requests Quantity Exceeded');

    // Check whether the apis are within whitelist or without blacklist
    // Blacklist has heigher priority
    let isForbidden = _.some(schema, function(obj) {
      obj = obj || {};
      if (options.forbiddenAPIs.length && options.forbiddenAPIs.indexOf(obj.method) > -1) return true;
      if (options.allowedAPIs.length && options.allowedAPIs.indexOf(obj.method) === -1) return true;
    });

    if (isForbidden) return new Error('Forbidden Request');
  }

  app.define(GATEWAY_METHOD_NAME, {
    description: 'Baiji gateway plugin method',
    route: { path: 'gateway', verb: 'post' }
  }, function(ctx, next) {
    let schema = ctx.body || {};
    let error = validateSchema(schema);
    if (error) {
      if (typeof options.onError === 'function') {
        return options.onError(ctx, error);
      } else {
        return ctx.done({ error: error.message });
      }
    } else {
      executeApis(ctx.body, ctx).then(res => {
        ctx.done(res, next);
      }).catch(err => {
        ctx.done(err, next);
      });
    }
  });
};
