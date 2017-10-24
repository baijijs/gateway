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
const semver = require('semver');

// Constant
const DEFAULT_GATEWAY_METHOD_NAME = '__gateway__';
const DEFAULT_GATEWAY_ROUTE_PATH = 'gateway';
const DEFAULT_GATEWAY_HTTP_METHOD = 'post';
const MINIMAL_VERSION_REQUIRED = '0.8.17';

// Create custom error with statusCode
function createError(statusCode, message) {
  let err = new Error(message);
  err.statusCode = err.status = statusCode == null ? 500 : statusCode;

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

  // Check baiji version
  assert(
    semver.satisfies(app.constructor.VERSION, `>= ${MINIMAL_VERSION_REQUIRED}`),
    `baiji-gateway plugin require baiji version larger than ${MINIMAL_VERSION_REQUIRED}`
  );

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
  let ALL_METHODS = [];

  // Filter all methods according to `allowedAPIs` and `forbiddenAPIs` option
  function filterAllowedMethods(app) {
    let allMethods = {};
    let allMethodNames = [];

    app.composedMethods().map(method => {
      // Ignore gateway method
      if (method.name === options.name) return;

      let methodName = method.fullName();

      allMethodNames.push(methodName);

      allMethods[methodName] = method;
    });

    // Filter all methods
    let filteredMethods = _.difference(allMethodNames, mm(allMethodNames, options.forbiddenAPIs));
    filteredMethods = mm(filteredMethods, options.allowedAPIs);

    return _.pick(allMethods, filteredMethods);
  }

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
      mockCtx.on('error', function(res) {
        reject(res.error);
      });

      mockCtx.on('finish', function(res) {
        resolve(res.result);
      });

      // Invoke method with mocked context
      method.invoke(mockCtx);
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
    let apis = [];
    _.map(schema, (api, name) => {
      // Check if api not contains a valid method
      if (!api.method) hasError = true;

      // Check if api depends on itself
      if (
        api.dependencies &&
        api.dependencies.length &&
        ~api.dependencies.indexOf(name)
      ) hasError = true;

      if (!~apis.indexOf(api.method)) apis.push(api.method);
    });
    let apisCount = apis.length;

    // Check whether the apis count is within tolerable range
    if (apisCount === 0 || hasError) return createError(422, 'Invalid Request Body');
    if (apisCount > options.max) return createError(406, 'Max Requests Exceeded');

    // Check whether the apis are within whitelist or without blacklist
    // Blacklist has heigher priority
    if (forbiddenAPIs.length && mm(apis, forbiddenAPIs).length) forbidden = true;
    if (allowedAPIs.length && mm(apis, allowedAPIs).length !== apis.length) forbidden = true;

    if (forbidden) return createError(403, 'Forbidden Request');
  }

  // Build special notes for swagger
  function buildNotes() {
    let title = 'Baiji gateway plugin method';
    let maxLength = 0;
    _.map(ALL_METHODS, (method, name) => {
      let length = name.length;
      if (maxLength < length) maxLength = length;
    });

    let notes = _.map(ALL_METHODS, (method, name) => {
      let paddedName = _.padEnd(`${name}`, maxLength, ' ');
      return `${paddedName} => ${method.description}`;
    }).join('\n');

    return `## ${title}\n\n### Support Methods:\n\`\`\`\n${notes} \n\`\`\``;
  }

  // Force obj1 key order by obj2
  function forceOrder(obj1, obj2) {
    let obj = {};
    _.map(obj2, function(val, key) {
      obj[key] = obj1[String(key)];
    });

    return obj;
  }

  // Refresh Gateway methods after mounted
  app.on('mount', function() {
    ALL_METHODS = filterAllowedMethods(this);

    // Define Gateway main method
    this.define(options.name, {
      description: 'Baiji gateway plugin method',
      notes: buildNotes(),
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
        return executeApis(schema, ctx).then(res => {
          // Force result has the same order with request schema
          res = forceOrder(res, schema);

          // Make sure result has same type of schema
          let data = Array.isArray(schema) ? _.values(res) : res;

          ctx.done(data, next);
        }).catch(err => {
          if (err && options.onError) {
            return options.onError(err, ctx, next);
          }
          ctx.status(err.status);
          return ctx.done(err, next);
        });
      }
    });
  });

  return null;
};
