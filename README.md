# Baiji Gateway

> Under active development

Gateway for baiji application

## Installation

Run `npm install baiji-gateway --save` to install it.

## Usage

``` javascript
// Options:
//   allowedAPIs: Whitelist api list
//   forbiddenAPIs: Blacklist api list
//   max: Maximum api requests at the same time
//   onError(err, ctx, next): Error handler
//   name: Gateway method name, default is `__gateway__`
//   path: Gateway api path, default is `gateway`
//   verb: Gateway http method, default is `post`

// Request body defination
{
  articles: {
    method: 'myApp.articles.index',
    params: { page: 1, perPage: 10 },
    dependencies: [
      'create'
    ]
  },
  create: {
    method: 'myApp.articles.create',
    params: { title: 'News', content: 'Blablabla .....' },
    dependencies: []
  }
}
```

License
-------
* [The MIT license](LICENSE)
