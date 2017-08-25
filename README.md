# Baiji Gateway

> Under active development

Gateway for baiji application

## Usage

``` javascript
// Options:
//   allowedAPIs: Whitelist api list
//   forbiddenAPIs: Blacklist api list
//   max: Maximum api requests at the same time
//   onError: Error handler

// Request body defination
{
  articles: {
    method: 'myApp.articles.index',
    params: 'any',
    dependencies: [
      'create'
    ]
  },
  create: {
    method: 'myApp.articles.create',
    params: 'any',
    dependencies: []
  }
}
```

License
-------
* [The MIT license](LICENSE)
