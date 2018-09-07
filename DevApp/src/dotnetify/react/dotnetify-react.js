﻿/* 
Copyright 2017-2018 Dicky Suryadi

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
 */
import _dotnetify from '../dotnetify-base';
import $ from '../jquery-shim';

if (typeof window == 'undefined') window = global;
let dotnetify = window.dotnetify || _dotnetify;

dotnetify.react = {
	version: '1.2.0',
	viewModels: {},
	plugins: {},

	// Internal variables.
	_responseSubs: null,
	_reconnectedSubs: null,
	_connectedSubs: null,
	_connectionFailedSubs: null,

	// Initializes connection to SignalR server hub.
	init: function() {
		const self = dotnetify.react;

		if (!self._responseSubs) {
			self._responseSubs = dotnetify.responseEvent.subscribe((iVMId, iVMData) => self._responseVM(iVMId, iVMData));
		}

		if (!self._connectedSubs) {
			self._connectedSubs = dotnetify.connectedEvent.subscribe(() =>
				Object.keys(self.viewModels).forEach((vmId) => !self.viewModels[vmId].$requested && self.viewModels[vmId].$request())
			);
		}

		const start = function() {
			if (!dotnetify.isHubStarted) Object.keys(self.viewModels).forEach((vmId) => (self.viewModels[vmId].$requested = false));
			dotnetify.startHub();
		};

		if (!self._reconnectedSubs) {
			self._reconnectedSubs = dotnetify.reconnectedEvent.subscribe(start);
		}

		dotnetify.initHub();
		start();
	},

	// Connects to a server view model.
	connect: function(iVMId, iReact, iOptions) {
		if (arguments.length < 2) throw new Error('[dotNetify] Missing arguments. Usage: connect(vmId, component) ');

		if (dotnetify.ssr && dotnetify.react.ssrConnect) {
			var vmArg = iOptions && iOptions['vmArg'];
			return dotnetify.react.ssrConnect(iVMId, iReact, vmArg);
		}

		var self = dotnetify.react;
		if (!self.viewModels.hasOwnProperty(iVMId)) self.viewModels[iVMId] = new dotnetifyVM(iVMId, iReact, iOptions);
		else
			console.error(
				`Component is attempting to connect to an already active '${iVMId}'. ` +
					` If it's from a dismounted component, you must add vm.$destroy to componentWillUnmount().`
			);

		self.init();
		return self.viewModels[iVMId];
	},

	// Get all view models.
	getViewModels: function() {
		var self = dotnetify.react;
		var vmArray = [];
		for (var vmId in self.viewModels) vmArray.push(self.viewModels[vmId]);
		return vmArray;
	},

	_responseVM: function(iVMId, iVMData) {
		const self = dotnetify.react;

		if (self.viewModels.hasOwnProperty(iVMId)) {
			const vm = self.viewModels[iVMId];
			dotnetify.checkServerSideException(iVMId, iVMData, vm.$exceptionHandler);
			vm.$update(iVMData);
			return true;
		}
		return false;
	}
};

// Client-side view model that acts as a proxy of the server view model.
class dotnetifyVM {
	// iVMId - identifies the view model.
	// iReact - React component.
	// iOptions - Optional configuration options:
	//    getState: state accessor.
	//    setState: state mutator.
	//    vmArg: view model arguments.
	//    headers: request headers, for things like authentication token.
	constructor(iVMId, iReact, iOptions) {
		this.$vmId = iVMId;
		this.$component = iReact;
		this.$vmArg = iOptions && iOptions['vmArg'];
		this.$headers = iOptions && iOptions['headers'];
		this.$exceptionHandler = iOptions && iOptions['exceptionHandler'];
		this.$requested = false;
		this.$loaded = false;
		this.$itemKey = {};

		var getState = iOptions && iOptions['getState'];
		var setState = iOptions && iOptions['setState'];
		getState = typeof getState === 'function' ? getState : () => iReact.state;
		setState = typeof setState === 'function' ? setState : (state) => iReact.setState(state);

		if (iReact && iReact.props && iReact.props.hasOwnProperty('vmArg')) this.$vmArg = $.extend(this.$vmArg, iReact.props.vmArg);

		this.State = (state) => (typeof state === 'undefined' ? getState() : setState(state));
		this.Props = (prop) => this.$component.props[prop];

		// Inject plugin functions into this view model.
		Object.keys(dotnetify.react.plugins).forEach((pluginId) => {
			var plugin = dotnetify.react.plugins[pluginId];
			if (plugin.hasOwnProperty('$inject')) plugin.$inject(this);
		});
	}

	// Disposes the view model, both here and on the server.
	$destroy() {
		// Call any plugin's $destroy function if provided.
		for (var pluginId in dotnetify.react.plugins) {
			var plugin = dotnetify.react.plugins[pluginId];
			if (typeof plugin['$destroy'] === 'function') plugin.$destroy.apply(this);
		}

		if (dotnetify.isConnected()) {
			try {
				dotnetify.disposeVM(this.$vmId);
			} catch (ex) {
				dotnetify._triggerConnectionStateEvent('error', ex);
			}
		}

		delete dotnetify.react.viewModels[this.$vmId];
	}

	// Dispatches a value to the server view model.
	// iValue - Vvalue to dispatch.
	$dispatch(iValue) {
		if (dotnetify.isConnected()) {
			try {
				dotnetify.updateVM(this.$vmId, iValue);

				if (dotnetify.debug) {
					console.log('[' + this.$vmId + '] sent> ');
					console.log(iValue);

					if (dotnetify.debugFn != null) dotnetify.debugFn(this.$vmId, 'sent', iValue);
				}
			} catch (ex) {
				dotnetify._triggerConnectionStateEvent('error', ex);
			}
		}
	}

	// Dispatches a state value to the server view model.
	// iValue - State value to dispatch.
	$dispatchListState(iValue) {
		for (var listName in iValue) {
			const key = this.$itemKey[listName];
			if (!key) {
				console.error(`[${this.$vmId}] missing item key for '${listName}'; add ${listName}_itemKey property to the view model.`);
				return;
			}
			var item = iValue[listName];
			if (!item[key]) {
				console.error(`[${this.$vmId}] couldn't dispatch data from '${listName}' due to missing property '${key}'.`);
				console.error(item);
				return;
			}

			Object.keys(item).forEach((prop) => {
				if (prop != key) {
					let state = {};
					state[listName + '.$' + item[key] + '.' + prop] = item[prop];
					this.$dispatch(state);
				}
			});
			this.$updateList(listName, item);
		}
	}

	// Preprocess view model update from the server before we set the state.
	$preProcess(iVMUpdate) {
		const vm = this;

		for (var prop in iVMUpdate) {
			// Look for property that end with '_add'. Interpret the value as a list item to be added
			// to an existing list whose property name precedes that suffix.
			var match = /(.*)_add/.exec(prop);
			if (match != null) {
				var listName = match[1];
				if (Array.isArray(this.State()[listName])) vm.$addList(listName, iVMUpdate[prop]);
				else console.error('unable to resolve ' + prop);
				delete iVMUpdate[prop];
				continue;
			}

			// Look for property that end with '_update'. Interpret the value as a list item to be updated
			// to an existing list whose property name precedes that suffix.
			var match = /(.*)_update/.exec(prop);
			if (match != null) {
				var listName = match[1];
				if (Array.isArray(this.State()[listName])) vm.$updateList(listName, iVMUpdate[prop]);
				else console.error('[' + this.$vmId + "] '" + listName + "' is not found or not an array.");
				delete iVMUpdate[prop];
				continue;
			}

			// Look for property that end with '_remove'. Interpret the value as a list item key to remove
			// from an existing list whose property name precedes that suffix.
			var match = /(.*)_remove/.exec(prop);
			if (match != null) {
				var listName = match[1];
				if (Array.isArray(this.State()[listName])) {
					var key = this.$itemKey[listName];
					if (key != null)
						vm.$removeList(listName, function(i) {
							return i[key] == iVMUpdate[prop];
						});
					else
						console.error(
							`[${this.$vmId}] missing item key for '${listName}'; add ${listName}_itemKey property to the view model.`
						);
				} else console.error(`[${this.$vmId}] '${listName}' is not found or not an array.`);
				delete iVMUpdate[prop];
				continue;
			}

			// Look for property that end with '_itemKey'. Interpret the value as the property name that will
			// uniquely identify items in the list.
			var match = /(.*)_itemKey/.exec(prop);
			if (match != null) {
				var listName = match[1];
				var itemKey = {};
				itemKey[listName] = iVMUpdate[prop];
				vm.$setItemKey(itemKey);
				delete iVMUpdate[prop];
				continue;
			}
		}
	}

	// Requests state from the server view model.
	$request() {
		if (dotnetify.isConnected()) {
			dotnetify.requestVM(this.$vmId, { $vmArg: this.$vmArg, $headers: this.$headers });
			this.$requested = true;
		}
	}

	// Updates state from the server view model to the view.
	// iVMData - Serialized state from the server.
	$update(iVMData) {
		if (dotnetify.debug) {
			console.log('[' + this.$vmId + '] received> ');
			console.log(JSON.parse(iVMData));

			if (dotnetify.debugFn != null) dotnetify.debugFn(this.$vmId, 'received', JSON.parse(iVMData));
		}
		var vmData = JSON.parse(iVMData);
		this.$preProcess(vmData);

		var state = this.State();
		state = $.extend({}, state, vmData);
		this.State(state);

		if (!this.$loaded) this.$onLoad();
	}

	// Handles initial view model load event.
	$onLoad() {
		// Call any plugin's $ready function if provided to give a chance to do
		// things when the view model is ready.
		for (var pluginId in dotnetify.react.plugins) {
			var plugin = dotnetify.react.plugins[pluginId];
			if (typeof plugin['$ready'] === 'function') plugin.$ready.apply(this);
		}
		this.$loaded = true;
	}

	// *** CRUD Functions ***

	// Sets items key to identify individual items in a list.
	// Accepts object literal: { "<list name>": "<key prop name>", ... }
	$setItemKey(iItemKey) {
		this.$itemKey = iItemKey;
	}

	//// Adds a new item to a state array.
	$addList(iListName, iNewItem) {
		// Check if the list already has an item with the same key. If so, replace it.
		var key = this.$itemKey[iListName];
		if (key != null) {
			if (!iNewItem.hasOwnProperty(key)) {
				console.error(`[${this.$vmId}] couldn't add item to '${iListName}' due to missing property '${key}'.`);
				return;
			}
			var match = this.State()[iListName].filter(function(i) {
				return i[key] == iNewItem[key];
			});
			if (match.length > 0) {
				console.error(`[${this.$vmId}] couldn't add item to '${iListName}' because the key already exists.`);
				return;
			}
		}

		let items = this.State()[iListName];
		items.push(iNewItem);

		let state = {};
		state[iListName] = items;
		this.State(state);
	}

	// Removes an item from a state array.
	$removeList(iListName, iFilter) {
		let state = {};
		state[iListName] = this.State()[iListName].filter((i) => !iFilter(i));
		this.State(state);
	}

	//// Updates existing item to an observable array.
	$updateList(iListName, iNewItem) {
		// Check if the list already has an item with the same key. If so, update it.
		let key = this.$itemKey[iListName];
		if (key != null) {
			if (!iNewItem.hasOwnProperty(key)) {
				console.error(`[${this.$vmId}] couldn't update item to '${iListName}' due to missing property '${key}'.`);
				return;
			}
			var state = {};
			state[iListName] = this.State()[iListName].map(function(i) {
				return i[key] == iNewItem[key] ? $.extend(i, iNewItem) : i;
			});
			this.State(state);
		} else console.error(`[${this.$vmId}] missing item key for '${iListName}'; add '${iListName}_itemKey' property to the view model.`);
	}
}

export default dotnetify;
