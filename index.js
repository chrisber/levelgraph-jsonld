
var jsonld = require('jsonld')
  , uuid   = require('uuid')
  , RDFTYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'
  , XSDTYPE = 'http://www.w3.org/2001/XMLSchema#'
  , async = require('async')
  , N3Util = require('n3/lib/N3Util'); // with browserify require('n3').Util would bundle more then needed!

function levelgraphJSONLD(db, jsonldOpts) {

  if (db.jsonld) {
    return db;
  }

  var graphdb = Object.create(db);

  jsonldOpts = jsonldOpts || {};
  jsonldOpts.base = jsonldOpts.base || '';

  graphdb.jsonld = {
      options: jsonldOpts
  };

  var doPut = function(obj, options, callback) {
    var blanks = {};

    jsonld.toRDF(obj, options, function(err, triples) {

      var stream = graphdb.putStream();

      stream.on('error', callback);
      stream.on('close', function() {
        callback(null, obj);
      });

      triples['@default'].map(function(triple) {

        return ['subject', 'predicate', 'object'].reduce(function(acc, key) {
          var node = triple[key];
          // generate UUID to identify blank nodes
          // uses type field set to 'blank node' by jsonld.js toRDF()
          if (node.type === 'blank node') {
            if (!blanks[node.value]) {
              blanks[node.value] = '_:' + uuid.v1();
            }
            node.value = blanks[node.value];
          }
          // preserve object data types using double quotation for literals
          // FIXME support language tags
          if(key === 'object' && triple.object.datatype && triple.object.datatype.match(XSDTYPE)){
            if(triple.object.datatype){
              if(triple.object.datatype === 'http://www.w3.org/2001/XMLSchema#string'){
                node.value = '"' + triple.object.value + '"';
              } else {
                node.value = '"' + triple.object.value + '"^^<' + triple.object.datatype + '>';
              }
            }
          }
          acc[key] = node.value;
          return acc;
        }, {});
      }).forEach(function(triple) {
        stream.write(triple);
      });
      stream.end();
    });
  };

  graphdb.jsonld.put = function(obj, options, callback) {
    if (typeof obj === 'string') {
      obj = JSON.parse(obj);
    }

    if (typeof options === 'function') {
      callback = options;
      options = {};
    }

    options.base = options.base || this.options.base;

    if (obj['@id']) {
      graphdb.jsonld.del(obj['@id'], options, function(err) {
        if (err) {
          return callback && callback(err);
        }
        doPut(obj, options, callback);
      });
    } else {
      obj['@id'] = options.base + uuid.v1();
      doPut(obj, options, callback);
    }
  };

  graphdb.jsonld.del = function(iri, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }

    if (typeof iri !=='string') {
      iri = iri['@id'];
    }

    var stream  = graphdb.delStream();
    stream.on('close', callback);
    stream.on('error', callback);

    (function delAllTriples(iri, done) {
      graphdb.get({ subject: iri }, function(err, triples) {
        async.each(triples, function(triple, cb) {
          stream.write(triple);
          if (triple.object.indexOf('_:') === 0) {
            delAllTriples(triple.object, cb);
          } else {
            cb();
          }
        }, done);
      });
    })(iri, function(err) {
      if (err) {
        return callback(err);
      }
      stream.end();
    });
  };

  // http://json-ld.org/spec/latest/json-ld-api/#data-round-tripping
  var coerceLiteral = function(literal) {
    var TYPES = {
      PLAIN: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#PlainLiteral',
      BOOLEAN: 'http://www.w3.org/2001/XMLSchema#boolean',
      INTEGER: 'http://www.w3.org/2001/XMLSchema#integer',
      DOUBLE: 'http://www.w3.org/2001/XMLSchema#double',
      STRING: 'http://www.w3.org/2001/XMLSchema#string',
    };
    var value = N3Util.getLiteralValue(literal);
    var type = N3Util.getLiteralType(literal);
    switch (type) {
      case TYPES.STRING:
      case TYPES.PLAIN:
        literal = value;
        break;
      case TYPES.INTEGER:
        literal = parseInt(value, 10);
        break;
      case TYPES.DOUBLE:
        literal = parseFloat(value);
        break;
      case TYPES.BOOLEAN:
        if (value === 'true' || value === '1') {
          literal = true;
        }
        if (value === 'false' || value === '0') {
          literal = false;
        }
        break;
      default:
        // FIXME deal with other types
    }
    return literal;
  };

  var fetchExpandedTriples = function(iri, memo, callback) {
    if (typeof memo === 'function') {
      callback = memo;
      memo = {};
    }

    graphdb.get({ subject: iri }, function(err, triples) {
      if (err || triples.length === 0) {
        return callback(err, null);
      }

      async.reduce(triples, memo, function(acc, triple, cb) {
        var key;

        if (!acc[triple.subject]) {
          acc[triple.subject] = { '@id': triple.subject };
        }
        if (triple.predicate === RDFTYPE) {
          if (acc[triple.subject]['@type']) {
            acc[triple.subject]['@type'] = [acc[triple.subject]['@type']];
            acc[triple.subject]['@type'].push(triple.object);
          } else {
            acc[triple.subject]['@type'] = triple.object;
          }
          cb(null, acc);
        } else if (!N3Util.isBlank(triple.object)) {
          acc[triple.subject][triple.predicate] = {};
          if (N3Util.isUri(triple.object)) {
            key = '@id';
          } else if (N3Util.isLiteral(triple.object)) {
            key = '@value';
            triple.object = coerceLiteral(triple.object);
            //FIXME support language tags
          }
          acc[triple.subject][triple.predicate][key] = triple.object;
          cb(null, acc);
        } else {
          fetchExpandedTriples(triple.object, function(err, expanded) {
            if (!acc[triple.subject][triple.predicate]) {
              acc[triple.subject][triple.predicate] = expanded[triple.object];
            } else {
              if (!acc[triple.subject][triple.predicate].push) {
                acc[triple.subject][triple.predicate] = [acc[triple.subject][triple.predicate]];
              }
              acc[triple.subject][triple.predicate].push(expanded[triple.object]);
            }
            cb(err, acc);
          });
        }
      }, callback);
    });
  };

  graphdb.jsonld.get = function(iri, context, options, callback) {

    if (typeof options === 'function') {
      callback = options;
      options = {};
    }

    fetchExpandedTriples(iri, function(err, expanded) {
      if (err || expanded === null) {
        return callback(err, expanded);
      }

      jsonld.compact(expanded[iri], context, options, callback);
    });
  };

  return graphdb;
}

module.exports = levelgraphJSONLD;

