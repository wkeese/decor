/** @module decor/observe */
define([
	"dcl/dcl",
	"./schedule"
], function (
	dcl,
	schedule
) {
	// Object.is() polyfill from Observable.js
	function is(lhs, rhs) {
		return lhs === rhs && (lhs !== 0 || 1 / lhs === 1 / rhs) || lhs !== lhs && rhs !== rhs;
	}

	// Deep compare oldObj to newObj and call notify() for properties that were changed or added in newObj.
	function diff(oldObj, newObj, notify, prefix) {
		for (var prop in newObj) {
			if (!oldObj || !(prop in oldObj) || !is(oldObj[prop], newObj[prop])) {
				if (newObj[prop] && typeof newObj[prop] === "object") {
					diff(oldObj && oldObj[prop], newObj[prop], notify, prefix + prop + ".");
				} else {
					notify(prefix + prop, oldObj ? oldObj[prop] : undefined, newObj[prop]);
				}
			}
		}
	}

	// Mapping from instrumented POJO to array of listeners to notify when that object is changed.
	var map = new WeakMap();

	// Call callback(prop, oldVal, newVal) whenever a property or nested property of the POJO is changed.
	// Callback is synchronous.
	function watchPojo(pojo, callback) {
		// Array of functions to call whenever a property or nested property of the POJO is changed.
		var callbacks = map.get(pojo);

		if (!callbacks) {
			callbacks = [];
			map.set(pojo, callbacks);

			// Go through each property in the object, and convert it to a custom setter and getter.
			Object.keys(pojo).forEach(function (prop) {
				// Shadow value referenced by setter and getter.
				var curVal = pojo[prop];

				// If property is an object then set up listener on that object too.
				var nestedWatcher;
				if (curVal && typeof curVal === "object") {
					nestedWatcher = watchPojo(curVal, function (nestedProp, oldVal, newVal) {
						callback(prop + "." + nestedProp, oldVal, newVal);
					});
				}

				// Convert property into setter and getter.
				Object.defineProperty(pojo, prop, {
					enumerable: true,

					set: function (newVal) {
						// Ignore when property set to same value as before.
						if (is(newVal, curVal)) {
							return;
						}

						// If old value was an object, then remove listener on that object.
						if (nestedWatcher) {
							nestedWatcher.remove();
							nestedWatcher = null;
						}

						// If new value is an object, set up listener on that object.
						if (newVal && typeof newVal === "object") {
							nestedWatcher = watchPojo(newVal, function (nestedProp, nestedOldVal, nestedNewVal) {
								callback(prop + "." + nestedProp, nestedOldVal, nestedNewVal);
							});
						}

						// Save new value.
						var oldVal = curVal;
						curVal = newVal;

						function notify(prop, oldVal, newVal) {
							callbacks.forEach(function (watcher) {
								watcher(prop, oldVal, newVal);
							});
						}

						if (newVal && typeof newVal === "object") {
							// Recursive diff oldVal vs. newVal and send notifications of nested prop changes.
							diff(oldVal, newVal, notify, prop + ".");
						} else {
							// Notify all listeners that property has changed.
							notify(prop, oldVal, newVal);
						}
					},

					get: function () {
						return curVal;
					}
				});
			});
		}

		callbacks.push(callback);

		return {
			remove: function () {
				var idx = callbacks.indexOf(callback);
				if (idx >= 0) {
					callbacks.splice(idx, 1);
				}
			}
		};
	}

	////////////////////////////////////////////////////////////////////////
	// Code to collect changes and deliver summary at end of microtask.
	////////////////////////////////////////////////////////////////////////

	// Keep track of order that callbacks were registered, we will call them in that order
	// regardless of the order the objects were updated.
	var seq = 0;

	// ChangeCollectors with pending change notifications (to be delivered at end of microtask).
	var hotChangeCollectors = {};

	// Handle to timer to deliver change notifications.
	var deliverHandle;

	// Object to be notified of changes to specified POJO, queue up those changes,
	// and eventually call the specified callback with summary of those changes.
	var ChangeCollector = dcl(null, {
		constructor: function (callback) {
			this._seq = seq++;
			this.callback = callback;
			this.oldVals = {};
		},

		onChange: function (prop, oldVal) {
			if (!(prop in this.oldVals)) {
				this.oldVals[prop] = oldVal;
				hotChangeCollectors[this._seq] = this;
			}

			// Setup timer to notify callbacks at the end of microtask.
			// Note: Notifications are published in the order that objects are modified, rather than
			// in the order that objects were watched.  asudoh said this was bad and decor/Observable
			// somehow does it the other way.
			if (!deliverHandle) {
				deliverHandle = schedule(deliverAllByTimeout);
			}
		},

		deliver: function () {
			var oldVals = this.oldVals;
			this.oldVals = {};
			this.callback(oldVals);
		}
	});

	// Deliver all pending change notifications in the order that the callbacks were registered.
	function deliverAllByTimeout() {
		for (var anyWorkDone = true; anyWorkDone;) {
			anyWorkDone = false;

			// Observation may stop during observer callback
			var callbacks = [];
			for (var s in hotChangeCollectors) {
				callbacks.push(hotChangeCollectors[s]);
			}
			hotChangeCollectors = {};

			callbacks = callbacks.sort(function (lhs, rhs) {
				return lhs._seq - rhs._seq;
			});

			for (var i = 0, l = callbacks.length; i < l; ++i) {
				callbacks[i].deliver();
				anyWorkDone = true;
			}
		}
		deliverHandle = null;
	}

	// Call `callback(oldVals)` whenever one or more properties on specified POJO are changed.
	function observePojo(pojo, callback) {
		var changeCollector = new ChangeCollector(callback);
		return watchPojo(pojo, changeCollector.onChange.bind(changeCollector));
	}

	/**
	 * Call `callback(oldVals)` whenever one or more properties or nested properties on specified object are changed.
	 * Object can be a POJO or a decor/Stateful subclass (i.e. an Object with an `observe()` method).
	 * Similar to decor/Observable and decor/Stateful, but with key difference that it
	 * attaches to an existing object.
	 *
	 * A watched POJO should be updated the same way as usual, ex: `obj.foo = bar`, rather
	 * than a setter API like `obj.set("foo", bar)`.
	 *
	 * The callback is called asynchronously in the spirit of decor/Stateful#observe(),
	 * i.e. a single notification of all the properties that were changed since the last
	 * microtask.
	 *
	 * Also, like decor/Observable, callbacks are called in the order they were registered regardless
	 * of the order the objects are updated in.
	 * (TODO: that won't really be true until this module and decor/Stateful (or decor/Observable)
	 * share the code for delivering the change notifications)
	 */
	return function (obj, callback) {
		if (typeof obj.observe === "function") {
			return obj.observe(callback);
		} else {
			return observePojo(obj, callback);
		}
	};
});
