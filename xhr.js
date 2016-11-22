/* global window, global, XMLHttpRequest */
var fixtureCore = require("./core");
var deparam = require("./helpers/deparam");
var assign = require('can-util/js/assign/assign');
var each = require('can-util/js/each/each');

// Save the real XHR object as XHR
var XHR = XMLHttpRequest,
	// Get a global reference.
	GLOBAL = typeof global !== "undefined"? global : window;

// Figure out props and events on XHR object - but start with some defaults
var props = [
	"type", "url", "async", "response", "responseText", "responseType",
	"responseXML", "responseURL", "status", "statusText", "readyState"
];
var events = ["abort", "error", "load", "loadend", "loadstart",  "progress", "readystatechange"];
(function(){
	var x = new XHR();
	for(var prop in x) {
		if(prop.indexOf("on") === 0) {
			if (events.indexOf(prop.substr(2)) === -1) {
				events.push(prop.substr(2));
			}
		} else if (props.indexOf(prop) === -1 && typeof x[prop] !== 'function') {
			props.push(prop);
		}
	}
})();

// This overwrites the default XHR with a mock XHR object.
// The mock XHR object's `.send` method is able to
// call the fixture callbacks or create a real XHR request
// and then respond normally.
GLOBAL.XMLHttpRequest = function() {
	var mockXHR = this;
	var realXHR = new XHR();

	// store real xhr on mockXHR
	this._xhr = realXHR;

	// create other properties needed by prototype functions
	this._requestHeaders = {};
	this.__events = {};

	// wire up events to forward from real xhr to fake xhr
	each(events, function(eventName) {
		realXHR["on" + eventName] = function() {
			mockXHR.callEvents(eventName);
			if(mockXHR["on" + eventName]) {
				return mockXHR["on" + eventName].apply(mockXHR, arguments);
			}
		};
	});

	// The way code detects if the browser supports onload is to check
	// if a new XHR object has the onload property, so setting it to null
	// passes that check.
	this.onload = null;
};

assign(XMLHttpRequest.prototype, {
	setRequestHeader: function(name, value){
		this._requestHeaders[name] = value;
	},
	open: function(type, url, async){
		this._xhr.type = type;
		this._xhr.url = url;
		this._xhr.async = async === false ? false : true;
	},
	getAllResponseHeaders: function(){
		return this._xhr.getAllResponseHeaders.apply(this._xhr, arguments);
	},
	addEventListener: function(ev, fn){
		var evs = this.__events[ev] = this.__events[ev] || [];
		evs.push(fn);
	},
	removeEventListener: function(ev, fn){
		var evs = this.__events[ev] = this.__events[ev] || [];
		var idx = evs.indexOf(fn);
		if(idx >= 0) {
			evs.splice(idx, 1);
		}
	},
	setDisableHeaderCheck: function(val){
		this._disableHeaderCheck = !!val;
	},
	getResponseHeader: function(key){
		return "";
	},
	abort: function() {
		var xhr = this._xhr;

		// If we are aborting a delayed fixture we have to make the fake
		// steps that are expected for `abort` to
		if(this.timeoutId !== undefined) {
			clearTimeout(this.timeoutId);
			if(xhr.open) {
				xhr.open(this.type, this.url, this.async === false ? false : true);
			}

			if(xhr.send) {
				xhr.send();
			}
		}

		return xhr.abort && xhr.abort();
	},
	callEvents: function(ev) {
		var evs = this.__events[ev] || [], fn;
		for(var i = 0, len = evs.length; i < len; i++) {
			fn = evs[i];
			fn.call(this);
		}
	},
	// This needs to compile the information necessary to see if
	// there is a corresponding fixture.
	// If there isn't a fixture, this should create a real XHR object
	// linked to the mock XHR instance and make a data request.
	// If there is a fixture, depending on the type of fixture the following happens:
	// - dynamic fixtures - call the dynamic fixture, use the result to update the
	//   mock XHR object and trigger its callbacks.
	// - redirect fixtures - create a real XHR linked to the mock XHR for the new url.
	send: function(data) {
		var mockXHR = this,
			type,
			xhrSettings,
			fixtureSettings;

		// derive the XHR settings object from the XHR object
		type = this.type.toLowerCase() || 'get';
		xhrSettings = {
			url: this.url,
			data: data,
			headers: this._requestHeaders,
			type: type,
			method: type,
			async: this.async,
			xhr: this
		};

		// if get or delete, the url should not include the querystring.
		// the querystring should be the data.
		if(!xhrSettings.data && xhrSettings.type === "get" || xhrSettings.type === "delete") {
			xhrSettings.data = deparam(xhrSettings.url.split("?")[1]);
			xhrSettings.url = xhrSettings.url.split("?")[0];
		}

		// Try to convert the request body to POJOs.
		if(typeof xhrSettings.data === "string") {
			try {
				xhrSettings.data = JSON.parse(xhrSettings.data);
			} catch(e) {
				xhrSettings.data = deparam(xhrSettings.data);
			}
		}

		// See if the XHR settings match a fixture.
		fixtureSettings = fixtureCore.get(xhrSettings);

		// If a dynamic fixture is being used, we call the dynamic fixture function and then
		// copy the response back onto the `mockXHR` in the right places.
		if(fixtureSettings && typeof fixtureSettings.fixture === "function") {

			this.timeoutId = fixtureCore.callDynamicFixture(xhrSettings, fixtureSettings, function(status, body, headers, statusText){
				body = typeof body === "string" ? body :  JSON.stringify(body);

				// we are no longer using the real XHR
				// set it to an object so that props like readyState can be set
				mockXHR._xhr = {};

				assign(mockXHR._xhr, {
					readyState: 4,
					status: status
				});

				var success = (status >= 200 && status < 300 || status === 304);
				if(success) {
					assign(mockXHR._xhr, {
						statusText: statusText || "OK",
						responseText: body
					});
				} else {
					assign(mockXHR._xhr, {
						statusText: statusText || "error",
						responseText: body
					});
				}

				mockXHR.getAllResponseHeaders = function() {
					var ret = [];
					each(headers || {}, function(value, name) {
						Array.prototype.push.apply(ret, [name, ': ', value, '\r\n']);
					});
					return ret.join('');
				};

				if(mockXHR.onreadystatechange) {
					mockXHR.onreadystatechange({ target: mockXHR });
				}

				// fire progress events
				mockXHR.callEvents("progress");
				if(mockXHR.onprogress) {
					mockXHR.onprogress();
				}

				mockXHR.callEvents("load");
				if(mockXHR.onload) {
					mockXHR.onload();
				}

				mockXHR.callEvents("loadend");
				if(mockXHR.onloadend) {
					mockXHR.onloadend();
				}
			});

			return;
		}
		// At this point there is either not a fixture or a redirect fixture.
		// Either way we are doing a request.
		var makeRequest = function() {
			mockXHR._xhr.open(mockXHR._xhr.type, mockXHR._xhr.url, mockXHR._xhr.async);
			if(mockXHR._requestHeaders) {
				Object.keys(mockXHR._requestHeaders).forEach(function(key) {
					mockXHR._xhr.setRequestHeader(key, mockXHR._requestHeaders[key]);
				});
			}
			return mockXHR._xhr.send(data);
		};

		if(fixtureSettings && typeof fixtureSettings.fixture === "number") {
			//!steal-remove-start
			fixtureCore.log(xhrSettings.url + " -> delay " + fixtureSettings.fixture + "ms");
			//!steal-remove-end
			this.timeoutId = setTimeout(makeRequest, fixtureSettings.fixture);
			return;
		}

		// if we do have a fixture, update the real XHR object.
		if(fixtureSettings) {
			//!steal-remove-start
			fixtureCore.log(xhrSettings.url + " -> " + fixtureSettings.url);
			//!steal-remove-end
			assign(mockXHR._xhr, fixtureSettings);
		}

		// Make the request.
		return makeRequest();
	}
});

// when props of mockXHR are get/set, return the prop from the real XHR
each(props, function(prop) {
	Object.defineProperty(XMLHttpRequest.prototype, prop, {
		get: function(){
			return this._xhr[prop];
		},
		set: function(newVal){
			if(this._xhr[prop] !== newVal) {
				this._xhr[prop] = newVal;
			}
		}
	});
});

GLOBAL.XMLHttpRequest._XHR = XHR;
