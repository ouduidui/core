/* eslint-disable no-restricted-globals */
/* eslint-disable no-restricted-syntax */
// 命令行参数解析
const args = require('minimist')(process.argv.slice(2))
const fs = require('fs')
const path = require('path')
// 终端多色彩输出
const chalk = require('chalk')
// 语义化版本
const semver = require('semver')
const currentVersion = require('../package.json').version
// 交互式询问
const { prompt } = require('enquirer')
// 执行命令
const execa = require('execa')

// 预发布id
const preId =
  args.preid ||
  (semver.prerelease(currentVersion) && semver.prerelease(currentVersion)[0])
// 是否空执行，则不会执行测试打包，只会打印执行命令，用于校验命令行参数
const isDryRun = args.dry
// 是否跳过测试
const skipTests = args.skipTests
// 是否跳过打包
const skipBuild = args.skipBuild
// 读取packages文件夹内容，过滤掉ts文件和隐藏文件（'.'开头的文件）
const packages = fs
  .readdirSync(path.resolve(__dirname, '../packages'))
  .filter(p => !p.endsWith('.ts') && !p.startsWith('.'))

// 跳过更新package版本
const skippedPackages = []

// 版本选项
const versionIncrements = [
  'patch', // 修补
  'minor', // 小版本
  'major', // 大版本
  // 预发布版本
  ...(preId ? ['prepatch', 'preminor', 'premajor', 'prerelease'] : [])
]

// 用于生成版本号
// semver.inc('3.2.4', 'prerelease', 'beta')  =>  3.2.5-beta.0
const inc = i => semver.inc(currentVersion, i, preId)
// 用于获取脚本命令路径
const bin = name => path.resolve(__dirname, '../node_modules/.bin/' + name)
// 命令执行函数
const run = (bin, args, opts = {}) =>
  execa(bin, args, { stdio: 'inherit', ...opts })
// 空执行函数
const dryRun = (bin, args, opts = {}) =>
  console.log(chalk.blue(`[dryrun] ${bin} ${args.join(' ')}`), opts)
// 执行函数
const runIfNotDry = isDryRun ? dryRun : run
// 获取分包的路径函数
const getPkgRoot = pkg => path.resolve(__dirname, '../packages/' + pkg)
// 打印步骤函数
const step = msg => console.log(chalk.cyan(msg))

// 主函数
async function main() {
  // 检查版本号
  let targetVersion = args._[0]

  // 如果没有版本号则询问方式获取版本号
  if (!targetVersion) {
    // no explicit version, offer suggestions
    const { release } = await prompt({
      type: 'select',
      name: 'release',
      message: 'Select release type',
      // 拼接版本号生成选项，外加custom自定义选项
      choices: versionIncrements.map(i => `${i} (${inc(i)})`).concat(['custom'])
    })

    // 如果是自定义选项的话，则通过input输入获取版本号
    if (release === 'custom') {
      targetVersion = (
        await prompt({
          type: 'input',
          name: 'version',
          message: 'Input custom version',
          initial: currentVersion
        })
      ).version
    } 
    // 否则直接使用选项
    else {
      targetVersion = release.match(/\((.*)\)/)[1]
    }
  }

  // 校验版本是否符合规范
  if (!semver.valid(targetVersion)) {
    throw new Error(`invalid target version: ${targetVersion}`)
  }

  // 确认版本号
  const { yes } = await prompt({
    type: 'confirm',
    name: 'yes',
    message: `Releasing v${targetVersion}. Confirm?`
  })

  if (!yes) {
    return
  }

  // run tests before release
  // 执行测试
  step('\nRunning tests...')
  if (!skipTests && !isDryRun) {
    await run(bin('jest'), ['--clearCache'])
    await run('pnpm', ['test', '--', '--bail'])
  } else {
    console.log(`(skipped)`)
  }

  // update all package versions and inter-dependencies
  step('\nUpdating cross dependencies...')
  // 更新所有包的版本号
  updateVersions(targetVersion)

  // build all packages with types
  step('\nBuilding all packages...')
  // 开始执行打包
  if (!skipBuild && !isDryRun) {
    await run('pnpm', ['run', 'build', '--', '--release'])
    // test generated dts files
    step('\nVerifying type declarations...')
    await run('pnpm', ['run', 'test-dts-only'])
  } else {
    console.log(`(skipped)`)
  }

  // generate changelog
  step('\nGenerating changelog...')
  // 生成changelog
  await run(`pnpm`, ['run', 'changelog'])

  // update pnpm-lock.yaml
  step('\nUpdating lockfile...')
  // 生成pnpm-lock.yaml
  await run(`pnpm`, ['install', '--prefer-offline'])

  // 执行git diff，判断是否有文件改动
  const { stdout } = await run('git', ['diff'], { stdio: 'pipe' })
  // 如果有文件改动，则提交代码
  if (stdout) {
    step('\nCommitting changes...')
    await runIfNotDry('git', ['add', '-A'])
    await runIfNotDry('git', ['commit', '-m', `release: v${targetVersion}`])
  } else {
    console.log('No changes to commit.')
  }

  // publish packages
  step('\nPublishing packages...')
  // 遍历所有分包，一一执行发布
  for (const pkg of packages) {
    await publishPackage(pkg, targetVersion, runIfNotDry)
  }

  // push to GitHub
  step('\nPushing to GitHub...')
  // 打上git tag
  await runIfNotDry('git', ['tag', `v${targetVersion}`])
  // 上传代码
  await runIfNotDry('git', ['push', 'origin', `refs/tags/v${targetVersion}`])
  await runIfNotDry('git', ['push'])

  if (isDryRun) {
    console.log(`\nDry run finished - run git diff to see package changes.`)
  }

  if (skippedPackages.length) {
    console.log(
      chalk.yellow(
        `The following packages are skipped and NOT published:\n- ${skippedPackages.join(
          '\n- '
        )}`
      )
    )
  }
  console.log()
}

// 更新所有包的版本号
function updateVersions(version) {
  // 1. update root package.json
  // 更新根目录的package.json
  updatePackage(path.resolve(__dirname, '..'), version)
  // 2. update all packages
  // 更新分包的package.json
  packages.forEach(p => updatePackage(getPkgRoot(p), version))
}

// 更新package.json
function updatePackage(pkgRoot, version) {
  // 获取package.json路径
  const pkgPath = path.resolve(pkgRoot, 'package.json')
  // 获取package.json内容
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
  // 更新版本
  pkg.version = version
  // 更新依赖
  updateDeps(pkg, 'dependencies', version)
  updateDeps(pkg, 'peerDependencies', version)
  // 更新文件
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
}

// 更新依赖的版本号
function updateDeps(pkg, depType, version) {
  const deps = pkg[depType]
  if (!deps) return
  // 遍历所以依赖
  Object.keys(deps).forEach(dep => {
    if (
      /* 如果是vue依赖 */
      dep === 'vue' ||
      /* 或者是vue的分包依赖，同时在packages文件夹中存在该分包的 */
      (dep.startsWith('@vue') && packages.includes(dep.replace(/^@vue\//, '')))
    ) {
      console.log(
        chalk.yellow(`${pkg.name} -> ${depType} -> ${dep}@${version}`)
      )
      // 更新版本号
      deps[dep] = version
    }
  })
}

// 发布包
async function publishPackage(pkgName, version, runIfNotDry) {
  if (skippedPackages.includes(pkgName)) {
    return
  }

  // 获取package.json内容
  const pkgRoot = getPkgRoot(pkgName)
  const pkgPath = path.resolve(pkgRoot, 'package.json')
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
  if (pkg.private) {
    return
  }

  // For now, all 3.x packages except "vue" can be published as
  // `latest`, whereas "vue" will be published under the "next" tag.
  // 生成tag
  let releaseTag = null
  if (args.tag) {
    releaseTag = args.tag
  } else if (version.includes('alpha')) {
    releaseTag = 'alpha'
  } else if (version.includes('beta')) {
    releaseTag = 'beta'
  } else if (version.includes('rc')) {
    releaseTag = 'rc'
  } else if (pkgName === 'vue') {
    // TODO remove when 3.x becomes default
    releaseTag = 'next'
  }

  // TODO use inferred release channel after official 3.0 release
  // const releaseTag = semver.prerelease(version)[0] || null

  step(`Publishing ${pkgName}...`)
  try {
    // 执行打包，即npm publish
    await runIfNotDry(
      // note: use of yarn is intentional here as we rely on its publishing
      // behavior.
      'yarn',
      [
        'publish',
        '--new-version',
        version,
        ...(releaseTag ? ['--tag', releaseTag] : []),
        '--access',
        'public'
      ],
      {
        cwd: pkgRoot,
        stdio: 'pipe'
      }
    )
    console.log(chalk.green(`Successfully published ${pkgName}@${version}`))
  } catch (e) {
    if (e.stderr.match(/previously published/)) {
      console.log(chalk.red(`Skipping already published: ${pkgName}`))
    } else {
      throw e
    }
  }
}

// 执行主函数
main().catch(err => {
  console.error(err)
})
