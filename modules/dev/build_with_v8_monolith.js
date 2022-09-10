const trimStart = (s)=> String.prototype.trimStart.call(s);
const slice = (s,...args)=> String.prototype.slice.call(s,...args);
const startsWithNspaces = (s,n,char=' ') => String.prototype.startsWith.call(s,`${new Array(n).fill(char).join('')}`)
const identedBy = s => s.length - trimStart(s).length
const trimIndent = (s,spaces) => 
  s.split('\n').map(
    (line,_idx,lines) => 
      startsWithNspaces(line, spaces || identedBy(lines[1]) ) 
        ? slice(line,identedBy(lines[1]))
        : line).join('\n');



(just = { sys: {}, process: {}, vm: {}}) => {
  const { print, error, builtin } = just
  const { launch, watch } = just.process
  const { cwd } = just.sys
  const { compile } = just.vm
  const { unlink, isDir, isFile, writeFile, mkdir, rmdir, readDir, chdir, rename } = just.fs
  
  const AD = '\u001b[0m' // ANSI Default
  const AG = '\u001b[32m' // ANSI Green
  const AY = '\u001b[33m' // ANSI Yellow
  const AR = '\u001b[31m' // ANSI Red
  // NodeJS Compatible API
  const console = { log: print };
  const { log } = console;
  
  function rmrf (dirName) {
    if (isDir(dirName)) {
      for (const entry of readDir(dirName)) {
        const { name } = entry
        if (name.length && (name !== '.' || name !== '..')) {
          if (isFile(`${dirName}/${name}`)) {
            log(`unlink ${dirName}/${name}`)
            unlink(`${dirName}/${name}`)
          } else {
            rmdir(dirName)
          }
        }
      }
    }
  }
  
  function safeWrite (fileName, str) {
    return (!isFile(fileName)) 
      ? writeFile(fileName, arrayBufferFromString(str))
      : 0
  }
          
  function make (opts, ...args) {
    return (opts.silent) 
      ? watch(Object.assign(launch('make', [...args], cwd()),{
          onStdout(_buf, _len) {},
          onStderr(_buf, _len) {}  
        }))
      : watch(launch('make', [...args], cwd()))
  }
          
  const rx = /[./-]/g
  const asCName = (name) => name.replace(rx, '_')
  function linkFile (fileName, name) {
    return ((prefixedName = `_binary_${asCName(name)}`) => trimIndent(
      `.global ${prefixedName}_start
      ${prefixedName}_start:
              .incbin "${fileName}"
              .global ${prefixedName}_end
      ${prefixedName}_end:
      `))()
  }
  const replaceRootDir = (file,justDir) => file[0] === '/' 
    ? file.replace(`${justDir}/`, '') 
    : file
  function generateBuiltins (main, index, libs, embeds, modules, v8flags, v8flagsFromCommandLine = false, justDir = '') {
    // main.h
    return trimIndent(
      `${libs.concat(embeds).map((file) =>
          ((path = replaceRootDir(file,justDir).replace(rx, '_')) => `extern char _binary_${path}_start[];\nextern char _binary_${path}_end[];`)()
        ).join('')}
      extern "C" {
        ${modules.map((mod)=> 
          mod.exports ? mod.exports.map((e)=>`  extern void* _register_${e.name}();`)
            : `  extern void* _register_${mod.name}();`
        )}
      }
      void register_builtins() {
        ${libs.concat(embeds).map(((file) => 
          (path = replaceRootDir(file,justDir).replace(rx, '_')) => `  just::builtins_add("${file}", _binary_${path}_start, _binary_${path}_end - _binary_${path}_start);`)()
        ).join()}
        ${modules.map((mod)=>
          mod.exports ? mod.exports.map((e)=>`  just::modules["${e.name}"] = &_register_${e.name};`)
            : `  just::modules["${mod.name}"] = &_register_${mod.name};`
        )}
      }
      static unsigned int just_js_len = _binary_${main.replace(rx, '_')}_end - _binary_${main.replace(rx, '_')}_start;
      static const char* just_js = _binary_${main.replace(rx, '_')}_start;
      ${(index) 
        ? `static unsigned int index_js_len = _binary_${index.replace(rx, '_')}_end - _binary_${index.replace(rx, '_')}_start;
          static const char* index_js = _binary_${index.replace(rx, '_')}_start;
          lines.push('static unsigned int _use_index = 1;`
        : `static unsigned int index_js_len = 0;
          static const char* index_js = NULL;
          static unsigned int _use_index = 0;`}
      static const char* v8flags = "${v8flags}";
      static unsigned int _v8flags_from_commandline = ${v8flagsFromCommandLine ? 1 : 0};
      `);
  }
    
  function requireText (text, fileName = 'eval', dirName = cwd()) {
    const params = ['exports', 'require', 'module']
    const exports = {}
    const module = { exports, dirName, fileName, type: 'js' }
    module.text = text
    const fun = compile(module.text, fileName, params, [])
    module.function = fun
    fun.call(exports, exports, p => require(p, module), module)
    return module.exports
  }
  
  const arrayBufferFromString = (str) => /** @type {typeof ArrayBuffer & { fromString: (string)=>ArrayBuffer }} */ (ArrayBuffer).fromString(str)
  const timeNow = Date.now;
  const just = {
    "lib/build.js": {
      async run (config = {}, { cleanall = false, clean = false, dump = false, silent = false }={}) {
        const start = timeNow()
        let build = 'main'
        let moduleBuild = 'module'
        const text = builtin('config.js')
        if (!text) {
          error('config.js missing')
          return
        }
        const { HOME, JUST_TARGET, CFLAGS = '', LFLAGS = '' } = just.env()
        const justDir = JUST_TARGET || `${HOME}/.just`
        const appDir = cwd()
        const runtime = requireText(text)
        const {
          version = runtime.version || just.version.just,
          debug = runtime.debug || false,
          modules = runtime.modules || [],
          flags = runtime.flags || '',
          v8flagsFromCommandLine = runtime.v8flagsFromCommandLine || false,
          v8flags = runtime.v8flags || '',
          target = runtime.target || 'just',
          main = runtime.main || 'just.js',
          index = runtime.index || ''
        } = config || {}
        if (config.static === 'undefined') {
          config.static = runtime.static
        }
        if (config.static) {
          build = 'main-static'
          moduleBuild = 'module-static'
        }
        config.libs = config.libs || []
        config.embeds = config.embeds || []
        const links = {}
        if (config.target === 'just') {
          for (const fileName of config.libs) {
            if (isFile(`${appDir}/${fileName}`)) {
              links[fileName] = linkFile(fileName, fileName)
            } else {
              links[fileName] = linkFile(`${justDir}/${fileName}`, fileName)
            }
          }
          for (const fileName of config.embeds) {
            if (isFile(`${appDir}/${fileName}`)) {
              links[fileName] = linkFile(fileName, fileName)
            } else {
              links[fileName] = linkFile(`${justDir}/${fileName}`, fileName)
            }
          }
        } else {
          for (const fileName of config.libs) {
            if (fileName[0] === '/') {
              links[fileName] = linkFile(fileName, fileName.replace(`${justDir}/`, ''))
            } else {
              if (isFile(`${appDir}/${fileName}`)) {
                links[fileName] = linkFile(`${appDir}/${fileName}`, fileName)
              } else {
                links[fileName] = linkFile(`${justDir}/${fileName}`, fileName)
              }
            }
          }
          for (const fileName of config.embeds) {
            links[fileName] = linkFile(`${appDir}/${fileName}`, fileName)
          }
        }
        if (main === 'just.js') {
          for (const fileName of runtime.libs) {
            links[fileName] = linkFile(fileName, fileName)
          }
          for (const fileName of runtime.embeds) {
            links[fileName] = linkFile(fileName, fileName)
          }
          config.embeds = [...new Set([...config.embeds, ...[main, 'config.js']])]
          if (config.target !== 'just') {
            runtime.libs = runtime.libs.filter(lib => {
              if (lib === 'lib/build.js') return false
              if (lib === 'lib/repl.js') return false
              if (lib === 'lib/configure.js') return false
              if (lib === 'lib/acorn.js') return false
              return true
            })
          }
          config.libs = [...new Set([...config.libs, ...runtime.libs])]
          if (index) {
            links[index] = linkFile(`${appDir}/${index}`, index)
            if (config.target === 'just') {
              config.embeds = [...new Set([...config.embeds, ...runtime.embeds, ...[index]])]
            } else {
              config.embeds = [...new Set([...config.embeds, ...[index]])]
            }
          } else {
            if (config.target === 'just') {
              config.embeds = [...new Set([...config.embeds, ...runtime.embeds])]
            }
          }
        } else {
          config.embeds = [...new Set([...config.embeds, ...[main]])]
          links[main] = linkFile(`${appDir}/${main}`, main)
        }
        config.embeds = config.embeds.filter(embed => !(config.libs.indexOf(embed) > -1))
        config.modules = modules
        if (debug) {
          build = `${build}-debug`
          moduleBuild = `${moduleBuild}-debug`
        }
        config.LIBS = config.libs.join(' ')
        config.EMBEDS = config.embeds.join(' ')
        config.MODULES = modules.map(m => (m.exports ? (m.exports.map(e => e.obj).flat()) : m.obj)).flat().join(' ')
        config.LIB = modules.map(m => m.lib).flat().filter(v => v).map(v => `-l${v}`).join(' ')
        config.justDir = justDir
        if (dump) {
          config.build = build
          config.moduleBuild = moduleBuild
          return config
        }
        if (config.target !== 'just') {
          if (!isDir(justDir)) mkdir(justDir)
          chdir(justDir)
        }
        if (config.main === 'just.js') {
          if (!isFile('just.js')) writeFile('just.js', arrayBufferFromString(builtin('just.js')))
          if (!isFile('config.js')) writeFile('config.js', arrayBufferFromString(builtin('config.js')))
        }
        writeFile('builtins.S', arrayBufferFromString(Object.keys(links).map(k => links[k]).join('')))
        if (!isDir('lib')) mkdir('lib')
        const src = generateBuiltins(main, index, config.libs, config.embeds, modules, v8flags, v8flagsFromCommandLine, justDir)
        writeFile('main.h', arrayBufferFromString(src))
        for (const fileName of runtime.embeds) {
          if (!isFile(fileName)) {
            writeFile(fileName, arrayBufferFromString(builtin(fileName)))
          }
        }
        for (const lib of runtime.libs) {
          if (!isFile(lib)) {
            writeFile(lib, arrayBufferFromString(builtin(lib)))
          }
        }
        if (!isFile('deps/v8/libv8_monolith.a')) {
          log(`${AG}get v8 static library${AD} `, false)
          
          const status = await make({ silent }, 'deps/v8/libv8_monolith.a').then((status) => status ? `${AR}failed${AD}` : `${AG}complete${AD}`)
  
          log(`${status} in ${AY}${Math.floor((timeNow() - start) / 10) / 100}${AD} sec`)
        }
        if (modules.length && !isDir('modules')) {
          log(`${AG}get modules${AD} `, false)
          const p = await make({ silent }, 'modules')
          const status = p.status ? `${AR}failed${AD}` : `${AG}complete${AD}`
  
          log(`${status} in ${AY}${Math.floor((timeNow() - start) / 10) / 100}${AD} sec`)
        }
        if (clean) {
          log(`${AG}clean ${target}${AD} `, false)
          const p = await make({ silent }, `TARGET=${target}`, 'clean')
          const status = p.status ? `${AR}failed${AD}` : `${AG}complete${AD}`
  
          log(`${status} in ${AY}${Math.floor((timeNow() - start) / 10) / 100}${AD} sec`)
        }
        for (const module of modules) {
          if (cleanall) {
            log(`${AG}clean modules/${module.name}${AD} `, false)
            const p = await make({ silent }, '-C', `modules/${module.name}`, 'clean')
            const status = p.status ? `${AR}failed${AD}` : `${AG}complete${AD}`
    
            log(`${status} in ${AY}${Math.floor((timeNow() - start) / 10) / 100}${AD} sec`)
          }
          if (!isFile(`./modules/${module.name}/${module.name}.o`)) {
            log(`${AG}build modules/${module.name}${AD} `, false)
            const p = await make({ silent }, `MODULE=${module.name}`, `CFLAGS=${CFLAGS}`, `LFLAGS=${LFLAGS}`, moduleBuild)
            const status = p.status ? `${AR}failed${AD}` : `${AG}complete${AD}`
    
            log(`${status} in ${AY}${Math.floor((timeNow() - start) / 10) / 100}${AD} sec`)
          }
        }
        log(`${AG}build ${target}${AD} ${AY}${version}${AD} (${main}) `, false)
        const p = await make({ silent }, `FLAGS=${flags}`, `EMBEDS=${config.EMBEDS}`, `MAIN=${main}`, `RELEASE=${version}`, `LIBS=${config.LIBS}`, `MODULES=${config.MODULES}`, `TARGET=${target}`, `LIB=${config.LIB}`, `CFLAGS=${CFLAGS}`, `LFLAGS=${LFLAGS}`, build)
        const status = p.status ? `${AR}failed${AD}` : `${AG}complete${AD}`
        // TODO: remove dependency on Date
        log(`${status} in ${AY}${Math.floor((timeNow() - start) / 10) / 100}${AD} sec`)
        if (config.target !== 'just') {
          chdir(appDir)
          rename(`${justDir}/${target}`, `${appDir}/${target}`)
        }
      },
      init (name) {
        if (!isDir(name)) {
          mkdir(name)
        }
        chdir(name)
        safeWrite('config.json', JSON.stringify({ target: name, index: `${name}.js`, static: true }, null, '  '))
        safeWrite(`${name}.js`, 'just.log(just.memoryUsage().rss)\n')
        chdir('../')
      },
      clean () {
        // we don't want to do this for main build
        // todo unlink linker file
        unlink('Makefile')
        unlink('just.js')
        unlink('just.cc')
        unlink('just.h')
        unlink('main.cc')
        unlink('main.h')
        unlink('v8lib-0.0.6.tar.gz')
        unlink('modules.tar.gz')
        if (isDir('lib')) {
          unlink('lib/build.js')
          unlink('lib/fs.js')
          unlink('lib/inspector.js')
          unlink('lib/loop.js')
          unlink('lib/path.js')
          unlink('lib/process.js')
          unlink('lib/repl.js')
          unlink('lib/websocket.js')
          unlink('lib/acorn.js')
          unlink('lib/configure.js')
          const files = readDir('lib').filter(f => !(['.', '..'].indexOf(f.name) > -1))
          if (files.length === 0) {
            rmrf('lib')
          }
        }
        if (isDir('config')) {
          unlink('config.js')
          unlink('config/debugger.js')
          const files = readDir('config').filter(f => !(['.', '..'].indexOf(f.name) > -1))
          if (files.length === 0) {
            rmrf('config')
          }
        }
      }
    },
    "just.js": trimIndent(
      `function wrapHRTime (just) {
        const { hrtime } = just
        const u64 = hrtime()
        const u32 = new Uint32Array(u64.buffer)
        const start = Number(just.start)
        return () => {
          hrtime()
          return ((u32[1] * 0x100000000) + u32[0]) - start
        }
      }
    
      function wrapMemoryUsage (memoryUsage) {
        const mem = new BigUint64Array(16)
        return () => {
          memoryUsage(mem)
          return {
            rss: mem[0],
            total_heap_size: mem[1],
            used_heap_size: mem[2],
            external_memory: mem[3],
            heap_size_limit: mem[5],
            total_available_size: mem[10],
            total_heap_size_executable: mem[11],
            total_physical_size: mem[12]
          }
        }
      }
    
      function wrapCpuUsage (cpuUsage) {
        const cpu = new Uint32Array(4)
        const result = { elapsed: 0, user: 0, system: 0, cuser: 0, csystem: 0 }
        const clock = cpuUsage(cpu)
        const last = { user: cpu[0], system: cpu[1], cuser: cpu[2], csystem: cpu[3], clock }
        return () => {
          const clock = cpuUsage(cpu)
          result.elapsed = clock - last.clock
          result.user = cpu[0] - last.user
          result.system = cpu[1] - last.system
          result.cuser = cpu[2] - last.cuser
          result.csystem = cpu[3] - last.csystem
          last.user = cpu[0]
          last.system = cpu[1]
          last.cuser = cpu[2]
          last.csystem = cpu[3]
          last.clock = clock
          return result
        }
      }
    
      function wrapgetrUsage (getrUsage) {
        const res = new Float64Array(16)
        return () => {
          getrUsage(res)
          return {
            user: res[0],
            system: res[1],
            maxrss: res[2],
            ixrss: res[3],
            idrss: res[4],
            isrss: res[5],
            minflt: res[6],
            majflt: res[7],
            nswap: res[8],
            inblock: res[9],
            outblock: res[10],
            msgsnd: res[11],
            msgrcv: res[12],
            ssignals: res[13],
            nvcsw: res[14],
            nivcsw: res[15]
          }
        }
      }
    
      function wrapHeapUsage (heapUsage) {
        const heap = (new Array(16)).fill(0).map(v => new Float64Array(4))
        return () => {
          const usage = heapUsage(heap)
          usage.spaces = Object.keys(usage.heapSpaces).map(k => {
            const space = usage.heapSpaces[k]
            return {
              name: k,
              size: space[2],
              used: space[3],
              available: space[1],
              physicalSize: space[0]
            }
          })
          delete usage.heapSpaces
          return usage
        }
      }
    
      function wrapEnv (env) {
        return () => {
          return env()
            .map(entry => entry.split('='))
            .reduce((e, pair) => { e[pair[0]] = pair[1]; return e }, {})
        }
      }
    
      function wrapLibrary (cache = {}) {
        function loadLibrary (path, name) {
          if (cache[name]) return cache[name]
          if (!just.sys.dlopen) return {}
          const handle = just.sys.dlopen(path, just.sys.RTLD_LAZY)
          if (!handle) return {}
          const ptr = just.sys.dlsym(handle, ${'`_register_${name}`'})
          if (!ptr) return {}
          const lib = just.load(ptr)
          if (!lib) return {}
          lib.close = () => just.sys.dlclose(handle)
          lib.type = 'module-external'
          cache[name] = lib
          return lib
        }
    
        function library (name, path) {
          if (cache[name]) return cache[name]
          const lib = just.load(name)
          if (!lib) {
            if (path) return loadLibrary(path, name)
            return loadLibrary(${'`${name}.so`'}, name)
          }
          lib.type = 'module'
          cache[name] = lib
          return lib
        }
    
        return { library, cache }
      }
    
      function wrapRequire (cache = {}) {
        const appRoot = just.sys.cwd()
        const { HOME, JUST_TARGET } = just.env()
        const justDir = JUST_TARGET || ${'`${HOME}/.just`'}
    
        function requireNative (path) {
          path = ${'`lib/${path}.js`'}
          if (cache[path]) return cache[path].exports
          const { vm } = just
          const params = ['exports', 'require', 'module']
          const exports = {}
          const module = { exports, type: 'native', dirName: appRoot }
          module.text = just.builtin(path)
          if (!module.text) return
          const fun = vm.compile(module.text, path, params, [])
          module.function = fun
          cache[path] = module
          fun.call(exports, exports, p => just.require(p, module), module)
          return module.exports
        }
    
        function require (path, parent = { dirName: appRoot }) {
          const { join, baseName, fileName } = just.path
          if (path[0] === '@') path = ${'`${appRoot}/lib/${path.slice(1)}/${fileName(path.slice(1))}.js`'}
          const ext = path.split('.').slice(-1)[0]
          if (ext === 'js' || ext === 'json') {
            let dirName = parent.dirName
            const fileName = join(dirName, path)
            if (cache[fileName]) return cache[fileName].exports
            dirName = baseName(fileName)
            const params = ['exports', 'require', 'module']
            const exports = {}
            const module = { exports, dirName, fileName, type: ext }
            // todo: this is not secure
            if (just.fs.isFile(fileName)) {
              module.text = just.fs.readFile(fileName)
            } else {
              path = fileName.replace(appRoot, '')
              if (path[0] === '/') path = path.slice(1)
              module.text = just.builtin(path)
              if (!module.text) {
                path = ${'`${justDir}/${path}`'}
                if (!just.fs.isFile(path)) return
                module.text = just.fs.readFile(path)
                if (!module.text) return
              }
            }
            cache[fileName] = module
            if (ext === 'js') {
              const fun = just.vm.compile(module.text, fileName, params, [])
              module.function = fun
              fun.call(exports, exports, p => require(p, module), module)
            } else {
              module.exports = JSON.parse(module.text)
            }
            return module.exports
          }
          return requireNative(path, parent)
        }
    
        return { requireNative, require, cache }
      }
    
      function setTimeout (callback, timeout, repeat = 0, loop = just.factory.loop) {
        const buf = new ArrayBuffer(8)
        const timerfd = just.sys.timer(repeat, timeout)
        loop.add(timerfd, (fd, event) => {
          callback()
          just.fs.read(fd, buf, 0, buf.byteLength)
          if (repeat === 0) {
            loop.remove(fd)
            just.fs.close(fd)
          }
        })
        return timerfd
      }
    
      function setInterval (callback, timeout, loop = just.factory.loop) {
        return setTimeout(callback, timeout, timeout, loop)
      }
    
      function clearTimeout (fd, loop = just.factory.loop) {
        loop.remove(fd)
        just.fs.close(fd)
      }
    
      class SystemError extends Error {
        constructor (syscall) {
          const { sys } = just
          const errno = sys.errno()
          const message = ${'`${syscall} (${errno}) ${sys.strerror(errno)}`'}
          super(message)
          this.errno = errno
          this.name = 'SystemError'
        }
      }
    
      function setNonBlocking (fd) {
        let flags = just.fs.fcntl(fd, just.sys.F_GETFL, 0)
        if (flags < 0) return flags
        flags |= just.net.O_NONBLOCK
        return just.fs.fcntl(fd, just.sys.F_SETFL, flags)
      }
    
      function parseArgs (args) {
        const opts = {}
        args = args.filter(arg => {
          if (arg.slice(0, 2) === '--') {
            opts[arg.slice(2)] = true
            return false
          }
          return true
        })
        opts.args = args
        return opts
      }
    
      function main (opts) {
        const { library, cache } = wrapLibrary()
        let debugStarted = false
    
        delete global.console
    
        global.onUnhandledRejection = err => {
          just.error('onUnhandledRejection')
          if (err) just.error(err.stack)
        }
    
        // load the builtin modules
        just.vm = library('vm').vm
        just.loop = library('epoll').epoll
        just.fs = library('fs').fs
        just.net = library('net').net
        just.sys = library('sys').sys
        just.env = wrapEnv(just.sys.env)
    
        // todo: what about sharedarraybuffers?
        ArrayBuffer.prototype.writeString = function(str, off = 0) { // eslint-disable-line
          return just.sys.writeString(this, str, off)
        }
        ArrayBuffer.prototype.readString = function (len = this.byteLength, off = 0) { // eslint-disable-line
          return just.sys.readString(this, len, off)
        }
        ArrayBuffer.prototype.getAddress = function () { // eslint-disable-line
          return just.sys.getAddress(this)
        }
        ArrayBuffer.prototype.copyFrom = function (src, off = 0, len = src.byteLength, soff = 0) { // eslint-disable-line
          return just.sys.memcpy(this, src, off, len, soff)
        }
        arrayBufferFromString = str => just.sys.calloc(1, str)
        String.byteLength = just.sys.utf8Length
    
        const { requireNative, require } = wrapRequire(cache)
    
        just.SystemError = SystemError
        Object.assign(just.fs, requireNative('fs'))
        just.config = requireNative('config')
        just.path = requireNative('path')
        just.factory = requireNative('loop').factory
        just.factory.loop = just.factory.create(128)
        just.process = requireNative('process')
        just.setTimeout = setTimeout
        just.setInterval = setInterval
        just.clearTimeout = just.clearInterval = clearTimeout
        just.library = library
        just.requireNative = requireNative
        just.net.setNonBlocking = setNonBlocking
        just.require = global.require = require
        just.require.cache = cache
        just.hrtime = wrapHRTime(just)
        just.memoryUsage = wrapMemoryUsage(just.memoryUsage)
        just.cpuUsage = wrapCpuUsage(just.sys.cpuUsage)
        just.rUsage = wrapgetrUsage(just.sys.getrUsage)
        just.heapUsage = wrapHeapUsage(just.sys.heapUsage)
    
        function startup () {
          if (!just.args.length) return true
          if (just.workerSource) {
            const scriptName = just.path.join(just.sys.cwd(), just.args[0] || 'thread')
            just.main = just.workerSource
            delete just.workerSource
            just.vm.runScript(just.main, scriptName)
            return
          }
          if (just.args.length === 1) {
            const replModule = just.require('repl')
            if (!replModule) {
              throw new Error('REPL not enabled. Maybe I should be a standalone?')
            }
            replModule.repl()
            return
          }
          if (just.args[1] === '--') {
            // todo: limit size
            // todo: allow streaming in multiple scripts with a separator and running them all
            const buf = new ArrayBuffer(4096)
            const chunks = []
            let bytes = just.net.read(just.sys.STDIN_FILENO, buf, 0, buf.byteLength)
            while (bytes > 0) {
              chunks.push(buf.readString(bytes))
              bytes = just.net.read(just.sys.STDIN_FILENO, buf, 0, buf.byteLength)
            }
            just.vm.runScript(chunks.join(''), 'stdin')
            return
          }
          if (just.args[1] === 'eval') {
            just.vm.runScript(just.args[2], 'eval')
            return
          }
          if (just.args[1] === 'build') {
            const buildModule = just.require('build')
            if (!buildModule) throw new Error('Build not Available')
            let config
            if (just.opts.config) {
              config = require(just.args[2]) || {}
            } else {
              if (just.args.length > 2) {
                config = just.require('configure').run(just.args[2], opts)
              } else {
                config = require(just.args[2] || 'config.json') || require('config.js') || {}
              }
            }
            buildModule.run(config, opts)
              .then(cfg => {
                if (opts.dump) just.print(JSON.stringify(cfg, null, '  '))
              })
              .catch(err => just.error(err.stack))
            return
          }
          if (just.args[1] === 'init') {
            const buildModule = just.require('build')
            if (!buildModule) throw new Error('Build not Available')
            buildModule.init(just.args[2] || 'hello')
            return
          }
          if (just.args[1] === 'clean') {
            const buildModule = just.require('build')
            if (!buildModule) throw new Error('Build not Available')
            buildModule.clean()
            return
          }
          const scriptName = just.path.join(just.sys.cwd(), just.args[1])
          just.main = just.fs.readFile(just.args[1])
          if (opts.esm) {
            just.vm.runModule(just.main, scriptName)
          } else {
            just.vm.runScript(just.main, scriptName)
          }
        }
        if (opts.inspector) {
          const inspectorLib = just.library('inspector')
          if (!inspectorLib) throw new SystemError('inspector module is not enabled')
          just.inspector = inspectorLib.inspector
          // TODO: this is ugly
          Object.assign(just.inspector, require('inspector'))
          just.encode = library('encode').encode
          just.sha1 = library('sha1').sha1
          global.process = {
            pid: just.sys.pid(),
            version: 'v15.6.0',
            arch: 'x64',
            env: just.env()
          }
          const _require = global.require
          global.require = (name, path) => {
            if (name === 'module') return ['fs', 'process', 'repl']
            return _require(name, path)
          }
          global.inspector = just.inspector.createInspector({
            title: 'Just!',
            onReady: () => {
              if (debugStarted) return just.factory.run()
              debugStarted = true
              if (!startup()) just.factory.run()
            }
          })
          just.inspector.enable()
          just.factory.run(1)
          return
        }
        if (!startup()) just.factory.run()
      }
    
      const opts = parseArgs(just.args)
      just.args = opts.args
      just.opts = opts
      if (opts.bare) {
        just.load('vm').vm.runScript(just.args[1], 'eval')
      } else {
        main(opts)
      }`),
    "main.h": trimIndent(
      `extern char _binary_lib_fs_js_start[];
      extern char _binary_lib_fs_js_end[];
      extern char _binary_lib_loop_js_start[];
      extern char _binary_lib_loop_js_end[];
      extern char _binary_lib_path_js_start[];
      extern char _binary_lib_path_js_end[];
      extern char _binary_lib_process_js_start[];
      extern char _binary_lib_process_js_end[];
      extern char _binary_lib_build_js_start[];
      extern char _binary_lib_build_js_end[];
      extern char _binary_lib_repl_js_start[];
      extern char _binary_lib_repl_js_end[];
      extern char _binary_lib_configure_js_start[];
      extern char _binary_lib_configure_js_end[];
      extern char _binary_lib_acorn_js_start[];
      extern char _binary_lib_acorn_js_end[];
      extern char _binary_just_cc_start[];
      extern char _binary_just_cc_end[];
      extern char _binary_Makefile_start[];
      extern char _binary_Makefile_end[];
      extern char _binary_main_cc_start[];
      extern char _binary_main_cc_end[];
      extern char _binary_just_h_start[];
      extern char _binary_just_h_end[];
      extern char _binary_just_js_start[];
      extern char _binary_just_js_end[];
      extern char _binary_lib_inspector_js_start[];
      extern char _binary_lib_inspector_js_end[];
      extern char _binary_lib_websocket_js_start[];
      extern char _binary_lib_websocket_js_end[];
      extern char _binary_config_js_start[];
      extern char _binary_config_js_end[];
      extern "C" {
        extern void* _register_sys();
        extern void* _register_fs();
        extern void* _register_net();
        extern void* _register_vm();
        extern void* _register_epoll();
      }
      void register_builtins() {
        just::builtins_add("lib/fs.js", _binary_lib_fs_js_start, _binary_lib_fs_js_end - _binary_lib_fs_js_start);
        just::builtins_add("lib/loop.js", _binary_lib_loop_js_start, _binary_lib_loop_js_end - _binary_lib_loop_js_start);
        just::builtins_add("lib/path.js", _binary_lib_path_js_start, _binary_lib_path_js_end - _binary_lib_path_js_start);
        just::builtins_add("lib/process.js", _binary_lib_process_js_start, _binary_lib_process_js_end - _binary_lib_process_js_start);
        just::builtins_add("lib/build.js", _binary_lib_build_js_start, _binary_lib_build_js_end - _binary_lib_build_js_start);
        just::builtins_add("lib/repl.js", _binary_lib_repl_js_start, _binary_lib_repl_js_end - _binary_lib_repl_js_start);
        just::builtins_add("lib/configure.js", _binary_lib_configure_js_start, _binary_lib_configure_js_end - _binary_lib_configure_js_start);
        just::builtins_add("lib/acorn.js", _binary_lib_acorn_js_start, _binary_lib_acorn_js_end - _binary_lib_acorn_js_start);
        just::builtins_add("just.cc", _binary_just_cc_start, _binary_just_cc_end - _binary_just_cc_start);
        just::builtins_add("Makefile", _binary_Makefile_start, _binary_Makefile_end - _binary_Makefile_start);
        just::builtins_add("main.cc", _binary_main_cc_start, _binary_main_cc_end - _binary_main_cc_start);
        just::builtins_add("just.h", _binary_just_h_start, _binary_just_h_end - _binary_just_h_start);
        just::builtins_add("just.js", _binary_just_js_start, _binary_just_js_end - _binary_just_js_start);
        just::builtins_add("lib/inspector.js", _binary_lib_inspector_js_start, _binary_lib_inspector_js_end - _binary_lib_inspector_js_start);
        just::builtins_add("lib/websocket.js", _binary_lib_websocket_js_start, _binary_lib_websocket_js_end - _binary_lib_websocket_js_start);
        just::builtins_add("config.js", _binary_config_js_start, _binary_config_js_end - _binary_config_js_start);
        just::modules["sys"] = &_register_sys;
        just::modules["fs"] = &_register_fs;
        just::modules["net"] = &_register_net;
        just::modules["vm"] = &_register_vm;
        just::modules["epoll"] = &_register_epoll;
      }
      static unsigned int just_js_len = _binary_just_js_end - _binary_just_js_start;
      static const char* just_js = _binary_just_js_start;
      static unsigned int index_js_len = 0;
      static const char* index_js = NULL;
      static unsigned int _use_index = 0;
      static const char* v8flags = "--stack-trace-limit=10 --use-strict --disallow-code-generation-from-strings";
      static unsigned int _v8flags_from_commandline = 1;`),
    "main.cc": trimIndent(
      `#include "just.h"
      #include "main.h"
      
      int main(int argc, char** argv) {
        uint64_t start = just::hrtime();
        setvbuf(stdout, nullptr, _IONBF, 0);
        setvbuf(stderr, nullptr, _IONBF, 0);
        std::unique_ptr<v8::Platform> platform = v8::platform::NewDefaultPlatform();
        v8::V8::InitializePlatform(platform.get());
        v8::V8::SetFlagsFromString(v8flags);
        if (_v8flags_from_commandline == 1) {
          v8::V8::SetFlagsFromCommandLine(&argc, argv, true);
        }
        v8::V8::Initialize();
        register_builtins();
        if (_use_index) {
          just::CreateIsolate(argc, argv, just_js, just_js_len, 
            index_js, index_js_len, 
            NULL, 0, start);
        } else {
          just::CreateIsolate(argc, argv, just_js, just_js_len, start);
        }
        v8::V8::Dispose();
        platform.reset();
        return 0;
      }`),
    "just.h": trimIndent(
      `#ifndef JUST_H
      #define JUST_H
      
      #include <v8.h>
      #include <libplatform/libplatform.h>
      #include <map>
      #include <unistd.h>
      #include <fcntl.h>
      #include <sys/mman.h>
      #include <sys/utsname.h>
      
      namespace just {
      
      #define JUST_MICROS_PER_SEC 1e6
      
      using v8::String;
      using v8::NewStringType;
      using v8::Local;
      using v8::Isolate;
      using v8::Context;
      using v8::ObjectTemplate;
      using v8::FunctionCallbackInfo;
      using v8::Function;
      using v8::Object;
      using v8::Value;
      using v8::MaybeLocal;
      using v8::Module;
      using v8::TryCatch;
      using v8::Message;
      using v8::StackTrace;
      using v8::StackFrame;
      using v8::HandleScope;
      using v8::Integer;
      using v8::BigInt;
      using v8::FunctionTemplate;
      using v8::ScriptOrigin;
      using v8::True;
      using v8::False;
      using v8::ScriptCompiler;
      using v8::ArrayBuffer;
      using v8::Array;
      using v8::Maybe;
      using v8::HeapStatistics;
      using v8::Float64Array;
      using v8::HeapSpaceStatistics;
      using v8::BigUint64Array;
      using v8::Int32Array;
      using v8::Exception;
      using v8::FunctionCallback;
      using v8::Script;
      using v8::Platform;
      using v8::V8;
      using v8::BackingStore;
      using v8::SharedArrayBuffer;
      using v8::PromiseRejectMessage;
      using v8::Promise;
      using v8::PromiseRejectEvent;
      using v8::Uint32Array;
      using v8::BigUint64Array;
      using v8::FixedArray;
      
      enum ScriptType : int {
        kScript,
        kModule,
        kFunction,
      };
      
      enum HostDefinedOptions : int {
        kType = 8,
        kID = 9,
        kLength = 10,
      };
      
      ssize_t process_memory_usage();
      
      uint64_t hrtime();
      typedef void *(*register_plugin)();
      struct builtin {
        unsigned int size;
        const char* source;
      };
      extern std::map<std::string, builtin*> builtins;
      extern std::map<std::string, register_plugin> modules;
      void builtins_add (const char* name, const char* source, 
        unsigned int size);
      
      using InitializerCallback = void (*)(Isolate* isolate, 
        Local<ObjectTemplate> exports);
      v8::MaybeLocal<v8::Module> OnModuleInstantiate(v8::Local<v8::Context> context,
        v8::Local<v8::String> specifier, v8::Local<v8::FixedArray> import_assertions, 
        v8::Local<v8::Module> referrer);
      
      int CreateIsolate(int argc, char** argv, 
        const char* main, unsigned int main_len,
        const char* js, unsigned int js_len, struct iovec* buf, int fd,
        uint64_t start);
      int CreateIsolate(int argc, char** argv,
        const char* main, unsigned int main_len, uint64_t start);
      void PrintStackTrace(Isolate* isolate, const TryCatch& try_catch);
      void PromiseRejectCallback(PromiseRejectMessage message);
      void FreeMemory(void* buf, size_t length, void* data);
      
      void SET_METHOD(Isolate *isolate, Local<ObjectTemplate> 
        recv, const char *name, FunctionCallback callback);
      void SET_MODULE(Isolate *isolate, Local<ObjectTemplate> 
        recv, const char *name, Local<ObjectTemplate> module);
      void SET_VALUE(Isolate *isolate, Local<ObjectTemplate> 
        recv, const char *name, Local<Value> value);
      
      void log(const FunctionCallbackInfo<Value> &args);
      void Error(const FunctionCallbackInfo<Value> &args);
      void Load(const FunctionCallbackInfo<Value> &args);
      void Sleep(const FunctionCallbackInfo<Value> &args);
      void PID(const FunctionCallbackInfo<Value> &args);
      void Exit(const FunctionCallbackInfo<Value> &args);
      void Chdir(const FunctionCallbackInfo<Value> &args);
      void HRTime(const FunctionCallbackInfo<Value> &args);
      void AllocHRTime(const FunctionCallbackInfo<Value> &args);
      void Builtin(const FunctionCallbackInfo<Value> &args);
      void MemoryUsage(const FunctionCallbackInfo<Value> &args);
      void Builtins(const FunctionCallbackInfo<Value> &args);
      void Modules(const FunctionCallbackInfo<Value> &args);
      
      /**
        * Setup the target ObjectTemplate with 'just' property which holds the
        * basic functions in the runtime core
        * .version
        * .version.just
        * .version.v8
        * .version.kernel
        * .version.kernel.os
        * .version.kernel.release
        * .version.kernel.version
        * .log()
        * .error()
        * .load()
        * .pid()
        * .sleep()
        * .exit()
        * .chdir()
        * .builtin()
        * .memoryUsage()
      **/
      void Init(Isolate* isolate, Local<ObjectTemplate> target);
      
      }
      #endif`),
    "just.cc": trimIndent(
      `#include "just.h"
  
      std::map<std::string, just::builtin*> just::builtins;
      std::map<std::string, just::register_plugin> just::modules;
      uint32_t scriptId = 1;
      uint64_t* hrtimeptr;
      clock_t clock_id = CLOCK_MONOTONIC;
      
      ssize_t just::process_memory_usage() {
        char buf[1024];
        const char* s = NULL;
        ssize_t n = 0;
        unsigned long val = 0;
        int fd = 0;
        int i = 0;
        do {
          fd = open("/proc/thread-self/stat", O_RDONLY);
        } while (fd == -1 && errno == EINTR);
        if (fd == -1) return (ssize_t)errno;
        do
          n = read(fd, buf, sizeof(buf) - 1);
        while (n == -1 && errno == EINTR);
        close(fd);
        if (n == -1)
          return (ssize_t)errno;
        buf[n] = '\0';
        s = strchr(buf, ' ');
        if (s == NULL)
          goto err;
        s += 1;
        if (*s != '(')
          goto err;
        s = strchr(s, ')');
        if (s == NULL)
          goto err;
        for (i = 1; i <= 22; i++) {
          s = strchr(s + 1, ' ');
          if (s == NULL)
            goto err;
        }
        errno = 0;
        val = strtoul(s, NULL, 10);
        if (errno != 0)
          goto err;
        return val * (unsigned long)getpagesize();
      err:
        return 0;
      }
      
      uint64_t just::hrtime() {
        struct timespec t;
        if (clock_gettime(clock_id, &t)) return 0;
        return (t.tv_sec * (uint64_t) 1e9) + t.tv_nsec;
      }
      
      void just::builtins_add (const char* name, const char* source, 
        unsigned int size) {
        struct builtin* b = new builtin();
        b->size = size;
        b->source = source;
        builtins[name] = b;
      }
      
      void just::SET_METHOD(Isolate *isolate, Local<ObjectTemplate> 
        recv, const char *name, FunctionCallback callback) {
        recv->Set(String::NewFromUtf8(isolate, name, 
          NewStringType::kInternalized).ToLocalChecked(), 
          FunctionTemplate::New(isolate, callback));
      }
      
      void just::SET_MODULE(Isolate *isolate, Local<ObjectTemplate> 
        recv, const char *name, Local<ObjectTemplate> module) {
        recv->Set(String::NewFromUtf8(isolate, name, 
          NewStringType::kInternalized).ToLocalChecked(), 
          module);
      }
      
      void just::SET_VALUE(Isolate *isolate, Local<ObjectTemplate> 
        recv, const char *name, Local<Value> value) {
        recv->Set(String::NewFromUtf8(isolate, name, 
          NewStringType::kInternalized).ToLocalChecked(), 
          value);
      }
      
      void just::PrintStackTrace(Isolate* isolate, const TryCatch& try_catch) {
        HandleScope handleScope(isolate);
        Local<Message> message = try_catch.Message();
        Local<StackTrace> stack = message->GetStackTrace();
        Local<Value> scriptName = message->GetScriptResourceName();
        String::Utf8Value scriptname(isolate, scriptName);
        Local<Context> context = isolate->GetCurrentContext();
        int linenum = message->GetLineNumber(context).FromJust();
        v8::String::Utf8Value err_message(isolate, message->Get().As<String>());
        fprintf(stderr, "%s in %s on line %i\n", *err_message, *scriptname, linenum);
        if (stack.IsEmpty()) return;
        for (int i = 0; i < stack->GetFrameCount(); i++) {
          Local<StackFrame> stack_frame = stack->GetFrame(isolate, i);
          Local<String> functionName = stack_frame->GetFunctionName();
          Local<String> scriptName = stack_frame->GetScriptName();
          String::Utf8Value fn_name_s(isolate, functionName);
          String::Utf8Value script_name(isolate, scriptName);
          const int line_number = stack_frame->GetLineNumber();
          const int column = stack_frame->GetColumn();
          if (stack_frame->IsEval()) {
            if (stack_frame->GetScriptId() == Message::kNoScriptIdInfo) {
              fprintf(stderr, "    at [eval]:%i:%i\n", line_number, column);
            } else {
              fprintf(stderr, "    at [eval] (%s:%i:%i)\n", *script_name,
                line_number, column);
            }
            break;
          }
          if (fn_name_s.length() == 0) {
            fprintf(stderr, "    at %s:%i:%i\n", *script_name, line_number, column);
          } else {
            fprintf(stderr, "    at %s (%s:%i:%i)\n", *fn_name_s, *script_name,
              line_number, column);
          }
        }
        fflush(stderr);
      }
      
      void just::PromiseRejectCallback(PromiseRejectMessage data) {
        if (data.GetEvent() == v8::kPromiseRejectAfterResolved ||
            data.GetEvent() == v8::kPromiseResolveAfterResolved) {
          // Ignore reject/resolve after resolved.
          return;
        }
        Local<Promise> promise = data.GetPromise();
        Isolate* isolate = promise->GetIsolate();
        if (data.GetEvent() == v8::kPromiseHandlerAddedAfterReject) {
          return;
        }
        Local<Value> exception = data.GetValue();
        v8::Local<Message> message;
        // Assume that all objects are stack-traces.
        if (exception->IsObject()) {
          message = v8::Exception::CreateMessage(isolate, exception);
        }
        if (!exception->IsNativeError() &&
            (message.IsEmpty() || message->GetStackTrace().IsEmpty())) {
          // If there is no real Error object, manually create a stack trace.
          exception = v8::Exception::Error(
              v8::String::NewFromUtf8Literal(isolate, "Unhandled Promise."));
          message = Exception::CreateMessage(isolate, exception);
        }
        Local<Context> context = isolate->GetCurrentContext();
        TryCatch try_catch(isolate);
        Local<Object> globalInstance = context->Global();
        Local<Value> func = globalInstance->Get(context, 
          String::NewFromUtf8Literal(isolate, "onUnhandledRejection", 
            NewStringType::kNormal)).ToLocalChecked();
        if (func.IsEmpty()) {
          return;
        }
        Local<Function> onUnhandledRejection = Local<Function>::Cast(func);
        if (try_catch.HasCaught()) {
          fprintf(stderr, "PromiseRejectCallback: Cast\n");
          return;
        }
        Local<Value> argv[1] = { exception };
        MaybeLocal<Value> result = onUnhandledRejection->Call(context, 
          globalInstance, 1, argv);
        if (result.IsEmpty() && try_catch.HasCaught()) {
          fprintf(stderr, "PromiseRejectCallback: Call\n");
        }
      }
      
      void just::FreeMemory(void* buf, size_t length, void* data) {
        free(buf);
      }
      
      char* readFile(char filename[]) {
        std::ifstream file;
        file.open(filename, std::ifstream::ate);
        char* contents;
        if (!file) {
          contents = new char[1];
          return contents;
        }
        size_t file_size = file.tellg();
        file.seekg(0);
        std::filebuf* file_buf = file.rdbuf();
        contents = new char[file_size + 1]();
        file_buf->sgetn(contents, file_size);
        file.close();
        return contents;
      }
      
      v8::MaybeLocal<v8::Module> loadModule(char code[],
                                            char name[],
                                            v8::Local<v8::Context> cx) {
        v8::Local<v8::String> vcode =
            v8::String::NewFromUtf8(cx->GetIsolate(), code).ToLocalChecked();
        v8::Local<v8::PrimitiveArray> opts =
            v8::PrimitiveArray::New(cx->GetIsolate(), just::HostDefinedOptions::kLength);
        opts->Set(cx->GetIsolate(), just::HostDefinedOptions::kType,
                                  v8::Number::New(cx->GetIsolate(), just::ScriptType::kModule));
        v8::ScriptOrigin origin(cx->GetIsolate(), v8::String::NewFromUtf8(cx->GetIsolate(), name).ToLocalChecked(), // resource name
          0, // line offset
          0,  // column offset
          true, // is shared cross-origin
          -1,  // script id
          v8::Local<v8::Value>(), // source map url
          false, // is opaque
          false, // is wasm
          true, // is module
          opts);
        v8::Context::Scope context_scope(cx);
        v8::ScriptCompiler::Source source(vcode, origin);
        v8::MaybeLocal<v8::Module> mod;
        mod = v8::ScriptCompiler::CompileModule(cx->GetIsolate(), &source);
        return mod;
      }
      
      // lifted from here: https://gist.github.com/surusek/4c05e4dcac6b82d18a1a28e6742fc23e
      v8::MaybeLocal<v8::Module> just::OnModuleInstantiate(v8::Local<v8::Context> context,
                                             v8::Local<v8::String> specifier,
                                             v8::Local<v8::FixedArray> import_assertions, 
                                             v8::Local<v8::Module> referrer) {
        v8::String::Utf8Value str(context->GetIsolate(), specifier);
        return loadModule(readFile(*str), *str, context);
      }
      
      v8::Local<v8::Module> checkModule(v8::MaybeLocal<v8::Module> maybeModule,
                                        v8::Local<v8::Context> cx) {
        v8::Local<v8::Module> mod;
        if (!maybeModule.ToLocal(&mod)) {
          printf("Error loading module!\n");
          exit(EXIT_FAILURE);
        }
        v8::Maybe<bool> result = mod->InstantiateModule(cx, just::OnModuleInstantiate);
        if (result.IsNothing()) {
          printf("\nCan't instantiate module.\n");
          exit(EXIT_FAILURE);
        }
        return mod;
      }
      
      v8::Local<v8::Value> execModule(v8::Local<v8::Module> mod,
                                      v8::Local<v8::Context> cx,
                                      bool nsObject) {
        v8::Local<v8::Value> retValue;
        if (!mod->Evaluate(cx).ToLocal(&retValue)) {
          printf("Error evaluating module!\n");
          exit(EXIT_FAILURE);
        }
        if (nsObject)
          return mod->GetModuleNamespace();
        else
          return retValue;
      }
      
      v8::MaybeLocal<v8::Promise> OnDynamicImport(v8::Local<v8::Context> context,
        v8::Local<v8::Data> host_defined_options,
        v8::Local<v8::Value> resource_name,
        v8::Local<v8::String> specifier,
        v8::Local<v8::FixedArray> import_assertions) {
        v8::Local<v8::Promise::Resolver> resolver =
            v8::Promise::Resolver::New(context).ToLocalChecked();
        v8::MaybeLocal<v8::Promise> promise(resolver->GetPromise());
        v8::String::Utf8Value name(context->GetIsolate(), specifier);
        v8::Local<v8::Module> mod =
            checkModule(loadModule(readFile(*name), *name, context), context);
        v8::Local<v8::Value> retValue = execModule(mod, context, true);
        resolver->Resolve(context, retValue).ToChecked();
        return promise;
      }
      
      int just::CreateIsolate(int argc, char** argv, 
        const char* main_src, unsigned int main_len, 
        const char* js, unsigned int js_len, struct iovec* buf, int fd,
        uint64_t start) {
        Isolate::CreateParams create_params;
        int statusCode = 0;
        create_params.array_buffer_allocator = 
          ArrayBuffer::Allocator::NewDefaultAllocator();
        Isolate *isolate = Isolate::New(create_params);
        {
          Isolate::Scope isolate_scope(isolate);
          HandleScope handle_scope(isolate);
          // TODO: make this a config option
          isolate->SetCaptureStackTraceForUncaughtExceptions(true, 1000, 
            StackTrace::kDetailed);
          Local<ObjectTemplate> global = ObjectTemplate::New(isolate);
          Local<ObjectTemplate> just = ObjectTemplate::New(isolate);
          just::Init(isolate, just);
          global->Set(String::NewFromUtf8Literal(isolate, "just", 
            NewStringType::kNormal), just);
          Local<Context> context = Context::New(isolate, NULL, global);
          Context::Scope context_scope(context);
          isolate->SetPromiseRejectCallback(PromiseRejectCallback);
          isolate->SetHostImportModuleDynamicallyCallback(OnDynamicImport);
          Local<Array> arguments = Array::New(isolate);
          for (int i = 0; i < argc; i++) {
            arguments->Set(context, i, String::NewFromUtf8(isolate, argv[i], 
              NewStringType::kNormal, strlen(argv[i])).ToLocalChecked()).Check();
          }
          Local<Object> globalInstance = context->Global();
          globalInstance->Set(context, String::NewFromUtf8Literal(isolate, 
            "global", 
            NewStringType::kNormal), globalInstance).Check();
          Local<Value> obj = globalInstance->Get(context, 
            String::NewFromUtf8Literal(
              isolate, "just", 
              NewStringType::kNormal)).ToLocalChecked();
          Local<Object> justInstance = Local<Object>::Cast(obj);
          if (buf != NULL) {
            std::unique_ptr<BackingStore> backing = SharedArrayBuffer::NewBackingStore(
                buf->iov_base, buf->iov_len, [](void*, size_t, void*){}, nullptr);
            Local<SharedArrayBuffer> ab = SharedArrayBuffer::New(isolate, std::move(backing));
            justInstance->Set(context, String::NewFromUtf8Literal(isolate, 
              "buffer", NewStringType::kNormal), ab).Check();
          }
          if (start > 0) {
            justInstance->Set(context, String::NewFromUtf8Literal(isolate, "start", 
              NewStringType::kNormal), 
              BigInt::New(isolate, start)).Check();
          }
          if (fd != 0) {
            justInstance->Set(context, String::NewFromUtf8Literal(isolate, "fd", 
              NewStringType::kNormal), 
              Integer::New(isolate, fd)).Check();
          }
          justInstance->Set(context, String::NewFromUtf8Literal(isolate, "args", 
            NewStringType::kNormal), arguments).Check();
          if (js_len > 0) {
            justInstance->Set(context, String::NewFromUtf8Literal(isolate, 
              "workerSource", NewStringType::kNormal), 
              String::NewFromUtf8(isolate, js, NewStringType::kNormal, 
              js_len).ToLocalChecked()).Check();
          }
          TryCatch try_catch(isolate);
      
          Local<v8::PrimitiveArray> opts =
              v8::PrimitiveArray::New(isolate, just::HostDefinedOptions::kLength);
          opts->Set(isolate, just::HostDefinedOptions::kType, 
            v8::Number::New(isolate, just::ScriptType::kModule));
          ScriptOrigin baseorigin(
            isolate,
            String::NewFromUtf8Literal(isolate, "just.js", 
            NewStringType::kInternalized), // resource name
            0, // line offset
            0,  // column offset
            false, // is shared cross-origin
            scriptId++,  // script id
            Local<Value>(), // source map url
            false, // is opaque
            false, // is wasm
            true,  // is module
            opts
          );
          Local<String> base;
          base = String::NewFromUtf8(isolate, main_src, NewStringType::kNormal, 
            main_len).ToLocalChecked();
          ScriptCompiler::Source basescript(base, baseorigin);
          Local<Module> module;
          if (!ScriptCompiler::CompileModule(isolate, &basescript).ToLocal(&module)) {
            PrintStackTrace(isolate, try_catch);
            return 1;
          }
          Maybe<bool> ok2 = module->InstantiateModule(context, just::OnModuleInstantiate);
          if (ok2.IsNothing()) {
            if (try_catch.HasCaught() && !try_catch.HasTerminated()) {
              try_catch.ReThrow();
            }
            return 1;
          }
          module->Evaluate(context).ToLocalChecked();
          if (try_catch.HasCaught() && !try_catch.HasTerminated()) {
            try_catch.ReThrow();
            return 1;
          }
          Local<Value> func = globalInstance->Get(context, 
            String::NewFromUtf8Literal(isolate, "onExit", 
              NewStringType::kNormal)).ToLocalChecked();
          if (func->IsFunction()) {
            Local<Function> onExit = Local<Function>::Cast(func);
            Local<Value> argv[1] = {Integer::New(isolate, 0)};
            MaybeLocal<Value> result = onExit->Call(context, globalInstance, 0, argv);
            if (!result.IsEmpty()) {
              statusCode = result.ToLocalChecked()->Uint32Value(context).ToChecked();
            }
            if (try_catch.HasCaught() && !try_catch.HasTerminated()) {
              just::PrintStackTrace(isolate, try_catch);
              return 2;
            }
            statusCode = result.ToLocalChecked()->Uint32Value(context).ToChecked();
          }
        }
        isolate->ContextDisposedNotification();
        isolate->LowMemoryNotification();
        isolate->ClearKeptObjects();
        bool stop = false;
        while(!stop) {
          stop = isolate->IdleNotificationDeadline(1);  
        }
        isolate->Dispose();
        delete create_params.array_buffer_allocator;
        isolate = nullptr;
        return statusCode;
      }
      
      int just::CreateIsolate(int argc, char** argv, const char* main_src, 
        unsigned int main_len, uint64_t start) {
        return CreateIsolate(argc, argv, main_src, main_len, NULL, 0, NULL, 0, start);
      }
      
      void just::log(const FunctionCallbackInfo<Value> &args) {
        Isolate *isolate = args.GetIsolate();
        if (args[0].IsEmpty()) return;
        String::Utf8Value str(args.GetIsolate(), args[0]);
        int endline = 1;
        if (args.Length() > 1) {
          endline = static_cast<int>(args[1]->BooleanValue(isolate));
        }
        const char *cstr = *str;
        if (endline == 1) {
          fprintf(stdout, "%s\n", cstr);
        } else {
          fprintf(stdout, "%s", cstr);
        }
      }
      
      void just::Error(const FunctionCallbackInfo<Value> &args) {
        Isolate *isolate = args.GetIsolate();
        if (args[0].IsEmpty()) return;
        String::Utf8Value str(args.GetIsolate(), args[0]);
        int endline = 1;
        if (args.Length() > 1) {
          endline = static_cast<int>(args[1]->BooleanValue(isolate));
        }
        const char *cstr = *str;
        if (endline == 1) {
          fprintf(stderr, "%s\n", cstr);
        } else {
          fprintf(stderr, "%s", cstr);
        }
      }
      
      void just::Load(const FunctionCallbackInfo<Value> &args) {
        Isolate *isolate = args.GetIsolate();
        Local<Context> context = isolate->GetCurrentContext();
        Local<ObjectTemplate> exports = ObjectTemplate::New(isolate);
        if (args[0]->IsString()) {
          String::Utf8Value name(isolate, args[0]);
          auto iter = just::modules.find(*name);
          if (iter == just::modules.end()) {
            return;
          } else {
            register_plugin _init = (*iter->second);
            auto _register = reinterpret_cast<InitializerCallback>(_init());
            _register(isolate, exports);
          }
        } else {
          Local<BigInt> address64 = Local<BigInt>::Cast(args[0]);
          void* ptr = reinterpret_cast<void*>(address64->Uint64Value());
          register_plugin _init = reinterpret_cast<register_plugin>(ptr);
          auto _register = reinterpret_cast<InitializerCallback>(_init());
          _register(isolate, exports);
        }
        args.GetReturnValue().Set(exports->NewInstance(context).ToLocalChecked());
      }
      
      void just::Builtin(const FunctionCallbackInfo<Value> &args) {
        Isolate *isolate = args.GetIsolate();
        String::Utf8Value name(isolate, args[0]);
        just::builtin* b = builtins[*name];
        if (b == nullptr) {
          args.GetReturnValue().Set(Null(isolate));
          return;
        }
        if (args.Length() == 1) {
          args.GetReturnValue().Set(String::NewFromUtf8(isolate, b->source, 
            NewStringType::kNormal, b->size).ToLocalChecked());
          return;
        }
      
        std::unique_ptr<BackingStore> backing = SharedArrayBuffer::NewBackingStore(
            (void*)b->source, b->size, [](void*, size_t, void*){}, nullptr);
        Local<SharedArrayBuffer> ab = SharedArrayBuffer::New(isolate, std::move(backing));
      
        //Local<ArrayBuffer> ab = ArrayBuffer::New(isolate, (void*)b->source, b->size, v8::ArrayBufferCreationMode::kExternalized);
        args.GetReturnValue().Set(ab);
      }
      
      void just::MemoryUsage(const FunctionCallbackInfo<Value> &args) {
        Isolate *isolate = args.GetIsolate();
        ssize_t rss = just::process_memory_usage();
        HeapStatistics v8_heap_stats;
        isolate->GetHeapStatistics(&v8_heap_stats);
        Local<BigUint64Array> array;
        Local<ArrayBuffer> ab;
        if (args.Length() > 0) {
          array = args[0].As<BigUint64Array>();
          ab = array->Buffer();
        } else {
          ab = ArrayBuffer::New(isolate, 16 * 8);
          array = BigUint64Array::New(ab, 0, 16);
        }
        std::shared_ptr<BackingStore> backing = ab->GetBackingStore();
        uint64_t *fields = static_cast<uint64_t *>(backing->Data());
        fields[0] = rss;
        fields[1] = v8_heap_stats.total_heap_size();
        fields[2] = v8_heap_stats.used_heap_size();
        fields[3] = v8_heap_stats.external_memory();
        fields[4] = v8_heap_stats.does_zap_garbage();
        fields[5] = v8_heap_stats.heap_size_limit();
        fields[6] = v8_heap_stats.malloced_memory();
        fields[7] = v8_heap_stats.number_of_detached_contexts();
        fields[8] = v8_heap_stats.number_of_native_contexts();
        fields[9] = v8_heap_stats.peak_malloced_memory();
        fields[10] = v8_heap_stats.total_available_size();
        fields[11] = v8_heap_stats.total_heap_size_executable();
        fields[12] = v8_heap_stats.total_physical_size();
        fields[13] = isolate->AdjustAmountOfExternalAllocatedMemory(0);
        args.GetReturnValue().Set(array);
      }
      
      void just::Sleep(const FunctionCallbackInfo<Value> &args) {
        sleep(Local<Integer>::Cast(args[0])->Value());
      }
      
      void just::Exit(const FunctionCallbackInfo<Value>& args) {
        exit(Local<Integer>::Cast(args[0])->Value());
      }
      
      void just::PID(const FunctionCallbackInfo<Value> &args) {
        args.GetReturnValue().Set(Integer::New(args.GetIsolate(), getpid()));
      }
      
      void just::Chdir(const FunctionCallbackInfo<Value> &args) {
        Isolate *isolate = args.GetIsolate();
        String::Utf8Value path(isolate, args[0]);
        args.GetReturnValue().Set(Integer::New(isolate, chdir(*path)));
      }
      
      void just::Builtins(const FunctionCallbackInfo<Value> &args) {
        Isolate *isolate = args.GetIsolate();
        Local<Context> context = isolate->GetCurrentContext();
        Local<Array> b = Array::New(isolate);
        int i = 0;
        for (auto const& builtin : builtins) {
          b->Set(context, i++, String::NewFromUtf8(isolate, builtin.first.c_str(), 
            NewStringType::kNormal, builtin.first.length()).ToLocalChecked()).Check();
        }
        args.GetReturnValue().Set(b);
      }
      
      void just::Modules(const FunctionCallbackInfo<Value> &args) {
        Isolate *isolate = args.GetIsolate();
        Local<Context> context = isolate->GetCurrentContext();
        Local<Array> m = Array::New(isolate);
        int i = 0;
        for (auto const& module : modules) {
          m->Set(context, i++, String::NewFromUtf8(isolate, module.first.c_str(), 
            NewStringType::kNormal, module.first.length()).ToLocalChecked()).Check();
        }
        args.GetReturnValue().Set(m);
      }
      
      void just::HRTime(const FunctionCallbackInfo<Value> &args) {
        if (hrtimeptr != NULL) {
          *hrtimeptr = just::hrtime();
          return;
        }
        Isolate *isolate = args.GetIsolate();
        Local<BigUint64Array> array;
        Local<ArrayBuffer> ab;
        if (args.Length() > 0) {
          array = args[0].As<BigUint64Array>();
          ab = array->Buffer();
        } else {
          ab = ArrayBuffer::New(isolate, 8);
          array = BigUint64Array::New(ab, 0, 1);
          args.GetReturnValue().Set(array);
        }
        hrtimeptr = (uint64_t*)ab->GetBackingStore()->Data();
        *hrtimeptr = just::hrtime();
      }
      
      void just::Init(Isolate* isolate, Local<ObjectTemplate> target) {
        Local<ObjectTemplate> version = ObjectTemplate::New(isolate);
        SET_VALUE(isolate, version, "just", String::NewFromUtf8Literal(isolate, 
          JUST_VERSION));
        SET_VALUE(isolate, version, "v8", String::NewFromUtf8(isolate, 
          v8::V8::GetVersion()).ToLocalChecked());
        Local<ObjectTemplate> kernel = ObjectTemplate::New(isolate);
        utsname kernel_rec;
        int rc = uname(&kernel_rec);
        if (rc == 0) {
          kernel->Set(String::NewFromUtf8Literal(isolate, "os", 
            NewStringType::kNormal), String::NewFromUtf8(isolate, 
            kernel_rec.sysname).ToLocalChecked());
          kernel->Set(String::NewFromUtf8Literal(isolate, "release", 
            NewStringType::kNormal), String::NewFromUtf8(isolate, 
            kernel_rec.release).ToLocalChecked());
          kernel->Set(String::NewFromUtf8Literal(isolate, "version", 
            NewStringType::kNormal), String::NewFromUtf8(isolate, 
            kernel_rec.version).ToLocalChecked());
        }
        version->Set(String::NewFromUtf8Literal(isolate, "kernel", 
          NewStringType::kNormal), kernel);
        SET_METHOD(isolate, target, "print", Print);
        SET_METHOD(isolate, target, "error", Error);
       
        // TODO: move these four to sys library
        SET_METHOD(isolate, target, "exit", Exit);
        SET_METHOD(isolate, target, "pid", PID);
        SET_METHOD(isolate, target, "chdir", Chdir);
        SET_METHOD(isolate, target, "sleep", Sleep);
        SET_METHOD(isolate, target, "hrtime", HRTime);
      
        SET_MODULE(isolate, target, "version", version);
        // TODO: move this to vm library
        SET_METHOD(isolate, target, "memoryUsage", MemoryUsage);
      
        SET_METHOD(isolate, target, "load", Load);
        SET_METHOD(isolate, target, "builtin", Builtin);
        SET_METHOD(isolate, target, "builtins", Builtins);
        SET_METHOD(isolate, target, "modules", Modules);
      }`),
      "builtins.S": trimIndent(
        `.global _binary_lib_fs_js_start
        _binary_lib_fs_js_start:
                .incbin "lib/fs.js"
                .global _binary_lib_fs_js_end
        _binary_lib_fs_js_end:
        .global _binary_lib_loop_js_start
        _binary_lib_loop_js_start:
                .incbin "lib/loop.js"
                .global _binary_lib_loop_js_end
        _binary_lib_loop_js_end:
        .global _binary_lib_path_js_start
        _binary_lib_path_js_start:
                .incbin "lib/path.js"
                .global _binary_lib_path_js_end
        _binary_lib_path_js_end:
        .global _binary_lib_process_js_start
        _binary_lib_process_js_start:
                .incbin "lib/process.js"
                .global _binary_lib_process_js_end
        _binary_lib_process_js_end:
        .global _binary_lib_build_js_start
        _binary_lib_build_js_start:
                .incbin "lib/build.js"
                .global _binary_lib_build_js_end
        _binary_lib_build_js_end:
        .global _binary_lib_repl_js_start
        _binary_lib_repl_js_start:
                .incbin "lib/repl.js"
                .global _binary_lib_repl_js_end
        _binary_lib_repl_js_end:
        .global _binary_lib_configure_js_start
        _binary_lib_configure_js_start:
                .incbin "lib/configure.js"
                .global _binary_lib_configure_js_end
        _binary_lib_configure_js_end:
        .global _binary_lib_acorn_js_start
        _binary_lib_acorn_js_start:
                .incbin "lib/acorn.js"
                .global _binary_lib_acorn_js_end
        _binary_lib_acorn_js_end:
        .global _binary_just_cc_start
        _binary_just_cc_start:
                .incbin "just.cc"
                .global _binary_just_cc_end
        _binary_just_cc_end:
        .global _binary_Makefile_start
        _binary_Makefile_start:
                .incbin "Makefile"
                .global _binary_Makefile_end
        _binary_Makefile_end:
        .global _binary_main_cc_start
        _binary_main_cc_start:
                .incbin "main.cc"
                .global _binary_main_cc_end
        _binary_main_cc_end:
        .global _binary_just_h_start
        _binary_just_h_start:
                .incbin "just.h"
                .global _binary_just_h_end
        _binary_just_h_end:
        .global _binary_just_js_start
        _binary_just_js_start:
                .incbin "just.js"
                .global _binary_just_js_end
        _binary_just_js_end:
        .global _binary_lib_inspector_js_start
        _binary_lib_inspector_js_start:
                .incbin "lib/inspector.js"
                .global _binary_lib_inspector_js_end
        _binary_lib_inspector_js_end:
        .global _binary_lib_websocket_js_start
        _binary_lib_websocket_js_start:
                .incbin "lib/websocket.js"
                .global _binary_lib_websocket_js_end
        _binary_lib_websocket_js_end:
        .global _binary_config_js_start
        _binary_config_js_start:
                .incbin "config.js"
                .global _binary_config_js_end
        _binary_config_js_end:`),
        "config.js": trimIndent(
          `const libs = [
            'lib/fs.js',
            'lib/loop.js',
            'lib/path.js',
            'lib/process.js',
            'lib/build.js',
            'lib/repl.js',
            'lib/configure.js',
            'lib/acorn.js'
          ]
          
          const version = just.version.just
          const v8flags = '--stack-trace-limit=10 --use-strict --disallow-code-generation-from-strings'
          const v8flagsFromCommandLine = true
          const debug = false
          const capabilities = [] // list of allowed internal modules, api calls etc. TBD
          
          const modules = [{
            name: 'sys',
            obj: [
              'modules/sys/sys.o'
            ],
            lib: ['dl', 'rt']
          }, {
            name: 'fs',
            obj: [
              'modules/fs/fs.o'
            ]
          }, {
            name: 'net',
            obj: [
              'modules/net/net.o'
            ]
          }, {
            name: 'vm',
            obj: [
              'modules/vm/vm.o'
            ]
          }, {
            name: 'epoll',
            obj: [
              'modules/epoll/epoll.o'
            ]
          }]
          
          const embeds = [
            'just.cc',
            'Makefile',
            'main.cc',
            'just.h',
            'just.js',
            'config.js',
            'lib/websocket.js',
            'lib/inspector.js'
          ]
          
          const target = 'just'
          const main = 'just.js'
          
          module.exports = { version, libs, modules, capabilities, target, main, v8flags, embeds, static: false, debug, v8flagsFromCommandLine }`),
        "debugger.js": trimIndent(
          `const libs = [
            'lib/fs.js',
            'lib/loop.js',
            'lib/path.js',
            'lib/process.js',
            'lib/build.js',
            'lib/repl.js',
            'lib/configure.js',
            'lib/acorn.js',
            'lib/websocket.js',
            'lib/inspector.js'
          ]
          
          const version = just.version.just
          const v8flags = '--stack-trace-limit=10 --use-strict --disallow-code-generation-from-strings'
          const debug = false
          const capabilities = [] // list of allowed internal modules, api calls etc. TBD
          
          const modules = [{
            name: 'sys',
            obj: [
              'modules/sys/sys.o'
            ],
            lib: ['dl', 'rt']
          }, {
            name: 'sha1',
            obj: [
              'modules/sha1/sha1.o'
            ]
          }, {
            name: 'encode',
            obj: [
              'modules/encode/encode.o'
            ]
          }, {
            name: 'fs',
            obj: [
              'modules/fs/fs.o'
            ]
          }, {
            name: 'inspector',
            obj: [
              'modules/inspector/inspector.o'
            ]
          }, {
            name: 'net',
            obj: [
              'modules/net/net.o'
            ]
          }, {
            name: 'http',
            obj: [
              'modules/http/http.o',
              'modules/http/picohttpparser.o'
            ]
          }, {
            name: 'vm',
            obj: [
              'modules/vm/vm.o'
            ]
          }, {
            name: 'epoll',
            obj: [
              'modules/epoll/epoll.o'
            ]
          }]
          
          const embeds = [
            'just.cc',
            'Makefile',
            'main.cc',
            'just.h',
            'just.js',
            'config.js'
          ]
          
          const target = 'just'
          const main = 'just.js'
          
          module.exports = { version, libs, modules, capabilities, target, main, v8flags, embeds, static: false, debug }`),
        "Makefile": (CFLAGS="${CFLAGS}",LFLAGS="${LFLAGS}",INSTALL="${INSTALL}",TARGET="${TARGET}",MODULES="${MODULES}",MODULE="${MODULE}",LIB="${LIB}",FLAGS="${FLAGS}",LFLAG="${LFAG}",RELEASE="${RELEASE}")=>trimIndent(
          `CC=g++
          RELEASE=0.1.13
          INSTALL=/usr/local/bin
          LIBS=lib/loop.js lib/path.js lib/fs.js lib/process.js lib/build.js lib/repl.js lib/acorn.js lib/configure.js
          MODULES=modules/net/net.o modules/epoll/epoll.o modules/fs/fs.o modules/sys/sys.o modules/vm/vm.o
          TARGET=just
          LIB=-ldl -lrt
          EMBEDS=just.cc just.h Makefile main.cc lib/websocket.js lib/inspector.js just.js config.js
          FLAGS=${CFLAGS}
          LFLAG=${LFLAGS}
          JUST_HOME=$(shell pwd)
          
          .PHONY: help clean
          
          help:
            @awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z0-9_\.-]+:.*?## / {printf "\033[36m%-30s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)
          
          modules: ## download the modules for this release
            rm -fr modules
            curl -L -o modules.tar.gz https://github.com/just-js/modules/archive/$(RELEASE).tar.gz
            tar -zxvf modules.tar.gz
            mv modules-$(RELEASE) modules
            rm -f modules.tar.gz
          
          libs: ## download the libs for this release
            rm -fr libs-$(RELEASE)
            curl -L -o libs.tar.gz https://github.com/just-js/libs/archive/$(RELEASE).tar.gz
            tar -zxvf libs.tar.gz
            cp -fr libs-$(RELEASE)/* lib/
            rm -fr libs-$(RELEASE)
            rm -f libs.tar.gz
          
          examples: ## download the examples for this release
            rm -fr examples
            curl -L -o examples.tar.gz https://github.com/just-js/examples/archive/$(RELEASE).tar.gz
            tar -zxvf examples.tar.gz
            mv examples-$(RELEASE) examples
            rm -f examples.tar.gz
          
          v8headers: ## download v8 headers
            curl -L -o v8headers-$(RELEASE).tar.gz https://raw.githubusercontent.com/just-js/v8headers/$(RELEASE)/v8.tar.gz
            tar -zxvf v8headers-$(RELEASE).tar.gz
            rm -f v8headers-$(RELEASE).tar.gz
          
          deps/v8/libv8_monolith.a: ## download v8 monolithic library for linking
          ifeq (,$(wildcard /etc/alpine-release))
            curl -L -o v8lib-$(RELEASE).tar.gz https://raw.githubusercontent.com/just-js/libv8/$(RELEASE)/v8.tar.gz
          else
            curl -L -o v8lib-$(RELEASE).tar.gz https://raw.githubusercontent.com/just-js/libv8/$(RELEASE)/v8-alpine.tar.gz
          endif
            tar -zxvf v8lib-$(RELEASE).tar.gz
            rm -f v8lib-$(RELEASE).tar.gz
          
          v8src: ## download the full v8 source for this release
            curl -L -o v8src-$(RELEASE).tar.gz https://raw.githubusercontent.com/just-js/v8src/$(RELEASE)/v8src.tar.gz
            tar -zxvf v8src-$(RELEASE).tar.gz
            rm -f v8src-$(RELEASE).tar.gz
          
          module: ## build a shared library for a module 
            CFLAGS="$(FLAGS)" LFLAGS="${LFLAG}" JUST_HOME="$(JUST_HOME)" $(MAKE) -C modules/${MODULE}/ library
          
          module-static: ## build a shared library for a module 
            CFLAGS="$(FLAGS)" LFLAGS="${LFLAG}" JUST_HOME="$(JUST_HOME)" $(MAKE) -C modules/${MODULE}/ FLAGS=-DSTATIC library
          
          builtins.o: just.cc just.h Makefile main.cc ## compile builtins with build dependencies
            gcc builtins.S -c -o builtins.o
          
          debugger:
            just build --clean --config debugger.js
          
          main: modules builtins.o deps/v8/libv8_monolith.a
            $(CC) -c ${FLAGS} -DJUST_VERSION='"${RELEASE}"' -std=c++17 -DV8_COMPRESS_POINTERS -I. -I./deps/v8/include -g -O3 -march=native -mtune=native -Wpedantic -Wall -Wextra -flto -Wno-unused-parameter just.cc
            $(CC) -c ${FLAGS} -std=c++17 -DV8_COMPRESS_POINTERS -I. -I./deps/v8/include -g -O3 -march=native -mtune=native -Wpedantic -Wall -Wextra -flto -Wno-unused-parameter main.cc
            ifeq (${TARGET}, just)
            $(CC) -g -rdynamic -flto -pthread -m64 -Wl,--start-group deps/v8/libv8_monolith.a main.o just.o builtins.o ${MODULES} -Wl,--end-group ${LFLAG} ${LIB} -o ${TARGET} -Wl,-rpath=/usr/local/lib/${TARGET}
            else
            $(CC) -g -rdynamic -flto -pthread -m64 -Wl,--start-group deps/v8/libv8_monolith.a main.o just.o builtins.o ${MODULES} -Wl,--end-group ${LFLAG} ${LIB} -o ${TARGET}
            endif
            objcopy --only-keep-debug ${TARGET} ${TARGET}.debug
            strip --strip-debug --strip-unneeded ${TARGET}
            objcopy --add-gnu-debuglink=${TARGET}.debug ${TARGET}
          
          main-static: modules builtins.o deps/v8/libv8_monolith.a
            $(CC) -c ${FLAGS} -DJUST_VERSION='"${RELEASE}"' -std=c++17 -DV8_COMPRESS_POINTERS -I. -I./deps/v8/include -O3 -march=native -mtune=native -Wpedantic -Wall -Wextra -flto -Wno-unused-parameter just.cc
            $(CC) -c ${FLAGS} -std=c++17 -DV8_COMPRESS_POINTERS -I. -I./deps/v8/include -O3 -march=native -mtune=native -Wpedantic -Wall -Wextra -flto -Wno-unused-parameter main.cc
            ifeq (${TARGET}, just)
            $(CC) -g -static -flto -pthread -m64 -Wl,--start-group deps/v8/libv8_monolith.a main.o just.o builtins.o ${MODULES} -Wl,--end-group ${LFLAG} ${LIB} -o ${TARGET} -Wl,-rpath=/usr/local/lib/${TARGET}
            else
            $(CC) -g -static -flto -pthread -m64 -Wl,--start-group deps/v8/libv8_monolith.a main.o just.o builtins.o ${MODULES} -Wl,--end-group ${LFLAG} ${LIB} -o ${TARGET}
            endif
            objcopy --only-keep-debug ${TARGET} ${TARGET}.debug
            strip --strip-debug --strip-unneeded ${TARGET}
            objcopy --add-gnu-debuglink=${TARGET}.debug ${TARGET}
          
          module-net:
            $(MAKE) MODULE=net module
          
          module-sys:
            $(MAKE) MODULE=sys module
          
          module-epoll:
            $(MAKE) MODULE=epoll module
          
          module-vm:
            $(MAKE) MODULE=vm module
          
          module-fs:
            $(MAKE) MODULE=fs module
          
          module-static-net:
            $(MAKE) MODULE=net module-static
          
          module-static-sys:
            $(MAKE) MODULE=sys module-static
          
          module-static-epoll:
            $(MAKE) MODULE=epoll module-static
          
          module-static-vm:
            $(MAKE) MODULE=vm module-static
          
          module-static-fs:
            $(MAKE) MODULE=fs module-static
          
          runtime: deps/v8/libv8_monolith.a modules module-vm module-net module-sys module-epoll module-fs
            $(MAKE) main
          
          runtime-static: deps/v8/libv8_monolith.a modules module-static-vm module-static-net module-static-sys module-static-epoll module-static-fs
            $(MAKE) main-static
          
          clean: ## tidy up
            rm -f *.o
            rm -f ${TARGET}
          
          cleanall: ## remove just and build deps
            rm -fr deps
            rm -f *.gz
            rm -fr modules
            rm -fr libs
            rm -fr examples
            $(MAKE) clean
          
          install: ## install
            mkdir -p ${INSTALL}
            cp -f ${TARGET} ${INSTALL}/${TARGET}
          
          install-debug: ## install debug symbols
            mkdir -p ${INSTALL}/.debug
            cp -f ${TARGET}.debug ${INSTALL}/.debug/${TARGET}.debug
          
          uninstall: ## uninstall
            rm -f ${INSTALL}/${TARGET}
            rm -f ${INSTALL}/${TARGET}/.debug
          
          .DEFAULT_GOAL := help`)(),
  
  }
  
  
}
