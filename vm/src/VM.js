/**
 * @fileOverview Lua virtual machine class.
 * @author <a href="mailto:paul.cuthbertson@gamesys.co.uk">Paul Cuthbertson</a>
 * @copyright Gamesys Limited 2013
 */

var shine = shine || {};



/**
 * A Lua virtual machine.
 * @constructor
 * @extends shine.EventEmitter
 * @param {object} env Object containing global variables and methods from the host.
 */
shine.VM = function (env) {
	shine.EventEmitter.call(this);
	
	// this._files = [];
	// this._packagedFiles = {};
	this.fileManager = new shine.FileManager();
	this._env = env || {};
	this._coroutineStack = [];

	this._status = shine.RUNNING;
	this._resumeStack = [];
	this._callbackQueue = [];

	this._resetGlobals();
};

shine.VM.prototype = new shine.EventEmitter();
shine.VM.prototype.constructor = shine.VM;


shine.RUNNING = 0;
shine.SUSPENDING = 1;
shine.SUSPENDED = 2;
shine.RESUMING = 3;
shine.DEAD = 4;



	
/**
 * Resets all global variables to their original values.
 */
shine.VM.prototype._resetGlobals = function () {
	this._globals = this._bindLib(shine.lib);

	// Load standard lib into package.loaded:
	for (var i in this._globals) if (this._globals.hasOwnProperty(i) && this._globals[i] instanceof shine.Table) this._globals['package'].loaded[i] = this._globals[i];
	this._globals['package'].loaded._G = this._globals;

	// Load environment vars
	for (var i in this._env) if (this._env.hasOwnProperty(i)) this._globals[i] = this._env[i];
};




/**
 * Returns a copy of an object, with all functions bound to the VM. (recursive)
 */
shine.VM.prototype._bindLib = function (lib) {
	var result = shine.gc.createObject();

	for (var i in lib) {
		if (lib.hasOwnProperty(i)) {

			if (lib[i] && lib[i].constructor === shine.Table) {
				result[i] = new shine.Table(shine.utils.toObject(lib[i]));

			} else if (lib[i] && lib[i].constructor === Object) {
				result[i] = this._bindLib(lib[i]);

			} else if (typeof lib[i] == 'function') {
				result[i] = (function (func, context) {
					return function () { return func.apply(context, arguments); };
				})(lib[i], this);

			} else {
				result[i] = lib[i];
			}
		}
	}

	return new shine.Table(result);
};




/**
 * Loads a file containing compiled Luac code, decompiled to JSON.
 * @param {string} url The url of the file to load.
 * @param {boolean} [execute = true] Whether or not to execute the file once loaded.
 * @param {object} [coConfig] Coroutine configuration. Only applicable if execute == true.
 */
shine.VM.prototype.load = function (url, execute, coConfig) {
	var me = this;

	this.fileManager.load(url, function (err, file) {
		if (err) throw new URIError('Failed to load file: ' + url + ' (' + err + ')');

		me._trigger('file-loaded', file);
		if (execute || execute === undefined) me.execute(coConfig, file);
	});
};




/**
 * Executes the loaded Luac data.
 * @param {object} [coConfig] Coroutine configuration.
 * @param {shine.File} [file] A specific file to execute. If not present, executes all files in the order loaded.
 */
shine.VM.prototype.execute = function (coConfig, file) {
	var me = this,
		files = file? [file] : this._files,
		index,
		file,
		thread;


	if (!files.length) throw new Error ('No files loaded.'); 
	
	for (index in files) {
		if (files.hasOwnProperty(index)) {

			file = files[index];		
			if (!file.data) throw new Error('Tried to execute file before data loaded.');
		
		
			thread = this._thread = new shine.Function(this, file, file.data, this._globals);
			this._trigger('executing', [thread, coConfig]);
			
			try {
				if (!coConfig) {
					thread.call ();
					
				} else {
					var co = shine.lib.coroutine.wrap.call(this, thread),
						resume = function () {
							co();
							if (coConfig.uiOnly && co._coroutine.status != shine.DEAD) window.setTimeout(resume, 1);
						};
		
					resume();
				}
				
			} catch (e) {
				shine.Error.catchExecutionError(e);
			}
		}
	}
};




/**
 * Creates or updates a global in the guest environment.
 * @param {String} name Name of the global variable.
 * @param {Object} value Value.
 */
shine.VM.prototype.setGlobal = function (name, value) {
	this._globals[name] = value;
};




/**
 * Retrieves a global from the guest environment.
 * @param {String} name Name of the global variable.
 * @returns {Object} Value of the global variable.
 */
shine.VM.prototype.getGlobal = function (name) {
	return this._globals[name];
};




/**
 * Suspends any execution in the VM.
 */
shine.VM.prototype.suspend = function () {
	var vm = this;

	this._status = shine.SUSPENDING;

	window.setTimeout(function () {
		if (vm._status == shine.SUSPENDING) vm._status = shine.SUSPENDED;
	}, 1);
};




/**
 * Resumes execution in the VM from the point at which it was suspended.
 */
shine.VM.prototype.resume = function () {
	this._status = shine.RESUMING;
	// this._resumeVars = Array.splice.call(arguments, 0);

	var f = this._resumeStack.pop();

	if (f) {
		try {
			if (f instanceof shine.Coroutine) {
				f.resume();
			} else if (f instanceof shine.Closure) {
				f._run();
			} else {
				f();
			}
			
		} catch (e) {
			if (!((e || shine.EMPTY_OBJ) instanceof shine.Error)) {
				var stack = (e.stack || '');

				e = new shine.Error ('Error in host call: ' + e.message);
				e.stack = stack;
				e.luaStack = stack.split ('\n');
			}

			if (!e.luaStack) e.luaStack = shine.gc.createArray();
			e.luaStack.push([f, f._pc - 1]);

			shine.Error.catchExecutionError(e);
		}
	}
	
	// if (this._status == shine.RUNNING) this._trigger(shine.RUNNING);
	while (this._callbackQueue[0]) this._callbackQueue.shift()();
};




/**
 * Dumps memory associated with the VM.
 */
shine.VM.prototype.dispose = function () {
	var thread;

	for (var i in this._files) if (this._files.hasOwnProperty(i)) this._files[i].dispose();

	if (thread = this._thread) thread.dispose();

	delete this._files;
	delete this._thread;
	delete this._globals;
	delete this._env;
	delete this._coroutineStack;

	this.fileManager.dispose();
	delete this.fileManager;


	// Clear static stacks -- Very dangerous for environments that contain multiple VMs!
	shine.Closure._graveyard.length = 0;
	shine.Closure._current = undefined;
	shine.Coroutine._graveyard.length = 0;
};
