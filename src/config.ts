import * as fs from 'fs-extra'
import * as readJSON from 'load-json-file'
import * as os from 'os'
import * as path from 'path'
import * as readPkgUp from 'read-pkg-up'

import {IEngine} from './engine'
import {ICLIPJSON, IPluginPJSON, normalizePJSON} from './pjson'

const _pjson = require('../package.json')
const _base = `${_pjson.name}@${_pjson.version}`

export type PlatformTypes = 'darwin' | 'linux' | 'win32' | 'aix' | 'freebsd' | 'openbsd' | 'sunos'
export type ArchTypes = 'arm' | 'arm64' | 'mips' | 'mipsel' | 'ppc' | 'ppc64' | 's390' | 's390x' | 'x32' | 'x64' | 'x86'

export interface IConfigBase {
  arch: string
  bin: string
  cacheDir: string
  commandsDir: string | undefined
  configDir: string
  dataDir: string
  dirname: string
  errlog: string
  home: string
  hooks: {[k: string]: string[]}
  name: string
  pjson: IPluginPJSON | ICLIPJSON
  platform: string
  shell: string
  tsconfig: TSConfig | undefined
  userAgent: string
  version: string
  windows: boolean
  debug: number
}

export interface IPluginConfig extends IConfigBase {
  type: 'plugin'
  pjson: IPluginPJSON
}

export interface ICLIConfig extends IConfigBase {
  type: 'cli'
  pjson: ICLIPJSON
  engine: IEngine
  npmRegistry: string
}

export type IConfig = IPluginConfig | ICLIConfig

export interface TSConfig {
  compilerOptions: {
    rootDir?: string
    outDir?: string
  }
}

export interface ConfigOptions {
  name?: string
  root?: string
}

const debug = require('debug')('@dxcli/config')

export abstract class ConfigBase implements IConfigBase {
  static tsNode: any
  /**
   * registers ts-node for reading typescript source (./src) instead of compiled js files (./lib)
   * there are likely issues doing this any the tsconfig.json files are not compatible with others
   */
  static registerTSNode() {
    if (this.tsNode) return
    return this.tsNode = require('ts-node').register()
  }

  readonly _base = _base
  arch: string
  bin: string
  cacheDir: string
  configDir: string
  dataDir: string
  dirname: string
  errlog: string
  home: string
  name: string
  pjson: any
  platform: string
  root: string
  shell: string
  version: string
  windows: boolean
  userAgent: string
  commandsDir: string | undefined
  tsconfig: TSConfig | undefined
  debug: number = 0
  hooks: {[k: string]: string[]}

  constructor() {
    this.arch = (os.arch() === 'ia32' ? 'x86' : os.arch() as any)
    this.platform = os.platform() as any
    this.windows = this.platform === 'win32'
  }

  async load({name, root}: {name?: string, root: string}) {
    root = await findRootByName(name, root)
    const pkg = await readPkgUp({cwd: root})
    this.root = path.dirname(pkg.path)
    debug('found root at', this.root)
    this.pjson = normalizePJSON(pkg.pkg)

    this.name = this.pjson.name
    this.version = this.pjson.version
    this.bin = this.pjson.dxcli.bin
    this.dirname = this.pjson.dxcli.dirname
    this.userAgent = `${this.name}/${this.version} (${this.platform}-${this.arch}) node-${process.version}`
    this.shell = this._shell()
    this.debug = this._debug()

    this.home = process.env.HOME || (this.windows && this.windowsHome()) || os.homedir() || os.tmpdir()
    this.cacheDir = this.scopedEnvVar('CACHE_DIR') || this.macosCacheDir() || this.dir('cache')
    this.configDir = this.scopedEnvVar('CONFIG_DIR') || this.dir('config')
    this.dataDir = this.scopedEnvVar('DATA_DIR') || this.dir('data')
    this.errlog = path.join(this.cacheDir, 'error.log')

    this.tsconfig = await this._tsConfig()
    this.commandsDir = await this._libToSrcPath(this.pjson.dxcli.commands)
    this.hooks = await this._hooks()

    return this
  }

  scopedEnvVar(k: string) {
    return process.env[this.scopedEnvVarKey(k)]
  }

  scopedEnvVarTrue(k: string): boolean {
    let v = process.env[this.scopedEnvVarKey(k)]
    return v === '1' || v === 'true'
  }

  scopedEnvVarKey(k: string) {
    return [this.bin, k]
      .map(p => p.replace(/-/g, '_'))
      .join('_')
      .toUpperCase()
  }

  private dir(category: 'cache' | 'data' | 'config'): string {
    const base = process.env[`XDG_${category.toUpperCase()}_HOME`]
      || (this.windows && process.env.LOCALAPPDATA)
      || path.join(this.home, category === 'data' ? '.local/share' : '.' + category)
    return path.join(base, this.dirname)
  }

  private windowsHome() { return this.windowsHomedriveHome() || this.windowsUserprofileHome() }
  private windowsHomedriveHome() { return (process.env.HOMEDRIVE && process.env.HOMEPATH && path.join(process.env.HOMEDRIVE!, process.env.HOMEPATH!)) }
  private windowsUserprofileHome() { return process.env.USERPROFILE }
  private macosCacheDir(): string | undefined { return this.platform === 'darwin' && path.join(this.home, 'Library', 'Caches', this.dirname) || undefined }

  private async _tsConfig(): Promise<TSConfig | undefined> {
    try {
      const tsconfigPath = path.join(this.root, 'tsconfig.json')
      const tsconfig = await readJSON(path.join(this.root, 'tsconfig.json'))
      if (!tsconfig || !tsconfig.compilerOptions) return
      debug('tsconfig.json found at', tsconfigPath)
      return tsconfig
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
    }
  }

  /**
   * convert a path from the compiled ./lib files to the ./src typescript source
   * this is for developing typescript plugins/CLIs
   * if there is a tsconfig and the original sources exist, it attempts to require ts-
   */
  private async _libToSrcPath(orig: string): Promise<string | undefined> {
    if (!orig) return
    orig = path.join(this.root, orig)
    if (!this.tsconfig) return orig
    let {rootDir, outDir} = this.tsconfig.compilerOptions
    if (!rootDir || !outDir) return orig
    try {
      // rewrite path from ./lib/foo to ./src/foo
      const lib = path.join(this.root, outDir) // ./lib
      const src = path.join(this.root, rootDir) // ./src
      const relative = path.relative(lib, orig) // ./commands
      const out = path.join(src, relative) // ./src/commands
      debug('using ts files at', out)
      ConfigBase.registerTSNode()
      // this can be a directory of commands or point to a hook file
      // if it's a directory, we check if the path exists. If so, return the path to the directory.
      // For hooks, it might point to a module, not a file. Something like "./hooks/myhook"
      // That file doesn't exist, and the real file is "./hooks/myhook.ts"
      // In that case we attempt to resolve to the filename. If it fails it will revert back to the lib path
      if (!await fs.pathExists(out)) return require.resolve(out)
      return out
    } catch (err) {
      debug(err)
      return orig
    }
  }

  private async _hooks(): Promise<{[k: string]: string[]}> {
    const promises = Object.entries(this.pjson.dxcli.hooks)
      .map(([k, v]) => [k, v.map(this._libToSrcPath(v))] as [string, Promise<string>[]])
    const hooks: {[k: string]: string[]} = {}
    for (let [k, v] of promises) {
      hooks[k] = await Promise.all(v)
    }
    return hooks
  }

  private _shell(): string {
    let shellPath
    const {SHELL, COMSPEC} = process.env
    if (SHELL) {
      shellPath = SHELL.split('/')
    } else if (this.windows && COMSPEC) {
      shellPath = COMSPEC.split(/\\|\//)
    } else {
      shellPath = ['unknown']
    }
    return shellPath[shellPath.length - 1]
  }

  private _debug(): number {
    try {
      let debug = require('debug')(this.bin).enabled || this.scopedEnvVarTrue('DEBUG')
      return debug ? 1 : 0
    } catch { return 0 }
  }
}

export class PluginConfig extends ConfigBase implements IPluginConfig {
  static async create({name, root = __dirname}: ConfigOptions) {
    const config = new this()
    await config.load({root, name})
    return config
  }

  readonly type: 'plugin' = 'plugin'
  pjson: IPluginPJSON
}

export class CLIConfig extends ConfigBase implements ICLIConfig {
  static async create({engine, name, root = __dirname}: ConfigOptions & {engine: IEngine}) {
    const config = new this(engine)
    await config.load({name, root})
    return config
  }

  readonly type: 'cli' = 'cli'
  pjson: ICLIPJSON
  engine: IEngine
  npmRegistry: string

  constructor(engine: IEngine) {
    super()
    this.engine = engine
  }

  async load({root, name}: {root: string, name?: string}) {
    await super.load({root, name})
    this.npmRegistry = this.scopedEnvVar('NPM_REGISTRY') || this.pjson.dxcli.npmRegistry || 'https://registry.yarnpkg.com'
    return this
  }
}

export type Config = PluginConfig | CLIConfig

/**
 * find package root
 * for packages installed into node_modules this will go up directories until
 * it finds a node_modules directory with the plugin installed into it
 *
 * This is needed because of the deduping npm does
 */
async function findRootByName(name: string | undefined, root: string) {
  if (!name) return root
  // essentially just "cd .."
  function* up(from: string) {
    while (path.dirname(from) !== from) {
      yield from
      from = path.dirname(from)
    }
    yield from
  }
  for (let next of up(root)) {
    const cur = path.join(next, 'node_modules', name, 'package.json')
    if (await fs.pathExists(cur)) return cur
  }
  return root
}

export function isIConfig(o: any): o is IConfig {
  return !!o._base
}