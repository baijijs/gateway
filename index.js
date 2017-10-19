'use strict';

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

const _ = require('lodash');
const assert = require('assert');
const mm = require('micromatch');

// Constant
const DEFAULT_GATEWAY_METHOD_NAME = '__gateway__';
const DEFAULT_GATEWAY_ROUTE_PATH = 'gateway';
const DEFAULT_GATEWAY_HTTP_METHOD = 'post';

// Create custom error with statusCode
function createError(statusCode, message) {
  let err = new Error(message);
  err.statusCode = err.status = statusCode == null ? statusCode : 500;

  err.toJSON = function() {
    return {
      statusCode: err.statusCode,
      status: err.status,
      message: err.message
    };
  };

  return err;
}

// Cast val to array
function castToArray(val) {
  val = val || [];
  val = Array.isArray(val) ? val : (val == null ? [] : [val]);
  return val;
}

// allowedAPIs: Whitelist api list, support unix glob pattern
// forbiddenAPIs: Blacklist api list, support unix glob pattern
// max: Maximum requests for once

/**
 * Baiji Gateway Plugin
 *
 * @param {Application} app baiji Application instance
 * @param {Object} options
 * @param {Array} options.allowedAPIs Whitelist api list, support unix glob pattern
 * @param {Array} options.forbiddenAPIs Blacklist api list, support unix glob pattern
 * @param {Number} options.max Maximum requests for once
 * @param {String} options.name Custom gateway method name
 * @param {String} options.path Custom gateway route path
 * @param {String} options.verb Custom gateway http method
 *
 * @public
 */
module.exports = function baijiGatewayPlugin(app, options) {
  options = Object.assign({}, options);
  options.max = options.max || 50;
  options.allowedAPIs = castToArray(options.allowedAPIs);
  options.forbiddenAPIs = castToArray(options.forbiddenAPIs);
  options.name = options.name || DEFAULT_GATEWAY_METHOD_NAME;
  options.path = options.path || DEFAULT_GATEWAY_ROUTE_PATH;
  options.verb = options.verb || DEFAULT_GATEWAY_HTTP_METHOD;

  if (options.onError) {
    assert(
      typeof options.onError === 'function',
      '`options.onError` must be a valid function'
    );
  }

  // Cache all methods
  const ALL_METHODS = {};
  app.composedMethods().map(method => {
    // Ignore gateway method
    if (method.name === options.name) return;

    ALL_METHODS[method.fullName()] = method;
  });

  // Invoke method by name
  function invokeApiByName(name, ctx, args) {
    let method = ALL_METHODS[name];

    let mockCtx = ctx.adapter.Context.create(
      ctx.request,
      ctx.response,
      method,
      ctx.options
    );

    mockCtx.setArgs(args || {});
    mockCtx._isMock = true;

    return new Promise(function(resolve, reject) {
      method.invoke(mockCtx, function(res) {
        if (res.error) return reject(res.error);
        resolve(res.result);
      });
    });
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

  // Execute all api requests according to definitions
  function executeApis(schema, ctx) {
    schema = schema || {};

    let result = {};

    let stack = _(schema)

    // Convert all api dependencies to array
    .map(function(api, name) {
      api = api || {};
      api.dependencies = castToArray(api.dependencies);
      return { name, api };
    })

    // Compare api priority by dependencies
    .tap(function(res) {
      return res.sort(function(a, b) {
        let a_dep = a.api.dependencies;
        let b_dep = b.api.dependencies;

        if (b_dep.indexOf(a.name) > -1) return -1;
        if (a_dep.indexOf(b.name) > -1) return 1;

        if (a_dep.length === 0 && b_dep.length !== 0) return -1;
        if (b_dep.length === 0 && a_dep.length !== 0) return 1;

        if (a_dep.length < b_dep.length) return -1;
        if (a_dep.length > b_dep.length) return 1;

        if (a.name > b.name) return -1;
        if (a.name < b.name) return 1;

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

    return execStack(stack).then(() => result);
  }

  // Validate schema and return proper error
  function validateSchema(schema) {
    schema = schema || {};

    let forbiddenAPIs = options.forbiddenAPIs;
    let allowedAPIs = options.allowedAPIs;

    let forbidden = false;

    let hasError;
    let apis = _.map(schema, val => {
      if (!val.method) hasError = true;
      return val.method;
    });
    let apisCount = apis.length;

    // Check whether the apis count is within tolerable range
    if (apisCount === 0 || hasError) return createError(422, 'Invalid Request Body');
    if (apisCount > options.max) return createError(406, 'Max Requests Exceeded');

    // Check whether the apis are within whitelist or without blacklist
    // Blacklist has heigher priority
    if (forbiddenAPIs.length && mm(apis, forbiddenAPIs).length) forbidden = true;
    if (allowedAPIs.length && mm(apis, options.allowedAPIs).length !== apis.length) forbidden = true;

    if (forbidden) return createError(403, 'Forbidden Request');
  }

  // Define Gateway main method
  app.define(options.name, {
    description: 'Baiji gateway plugin method',
    route: { path: options.path, verb: options.verb }
  }, function(ctx, next) {
    let schema = ctx.body || {};
    let error = validateSchema(schema);
    if (error) {
      if (options.onError) {
        return options.onError(error, ctx, next);
      } else {
        ctx.status(error.status);
        return ctx.done(error, next);
      }
    } else {
      return executeApis(ctx.body, ctx).then(res => {
        ctx.done(res, next);
      }).catch(err => {
        if (err && options.onError) {
          return options.onError(err, ctx, next);
        }
        ctx.status(err.status);
        return ctx.done(err, next);
      });
    }
  });
};
