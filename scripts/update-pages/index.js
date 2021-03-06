const path = require('path')
const chalk = require('chalk')
const globby = require('globby')
const fs = require('fs-extra')
const { exec, log } = require('../lib')
const xsddoc = require('../xsddoc/xsddoc')

// start configuration
const tempFolder = path.join(__dirname, '.tmp')
const sourceRepo = 'https://github.com/qualipool/swissrets.wiki.git'
const sourceFolderName = 'source'
const destinationFolderName = 'dest'
// end configuration

const escapeRegExp = string => string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const loudExecConfig = {
  stdio: 'inherit',
  printCommand: true
}

const addToken = (url, token) => url
  .replace(/^git/, token)
  .replace(/^https:\/\/github/, `https://${token}@github`)

// sanitized git-clone for not showing access tokens
const clone = async (repoUrl, folder, branch, token) => {
  log.info(`Cloning ${chalk.cyan(repoUrl)} into ${chalk.cyan(folder)}`)

  // use authentication
  if (token) {
    log.info(`Using token`)
    repoUrl = addToken(repoUrl, token)
  }

  // catch errors and remove sensisitve information
  return exec(`git clone -b ${branch} ${repoUrl} ${folder}`)
    .catch(err => {
      log.warn(err.result.stderr)
      return Promise.reject(new Error(err.message))
    })
}

// sanitized git-push for not showing access tokens
const push = async (repoUrl, token) => {
  log.info(`Pushing changes to ${chalk.cyan(repoUrl)}`)

  // use authentication
  if (token) {
    log.info(`Using token`)
    repoUrl = addToken(repoUrl, token)
  }

  // catch errors and remove sensisitve information
  return exec(`git push ${repoUrl}`)
    .catch(err => {
      log.warn(err.result.stderr)
      return Promise.reject(new Error(err.message))
    })
}

// 1. downloads the wiki repo and the gh-pages branch of this repo
// 2. sync md files from wiki to gh-branch
// 3. replace links with .html ending
// 4. add back link to top of non-home markdowns
// 5. generate the xsd docs
// 6. push it to gh-pages branch
const update = async () => {
  const token = process.env.GITHUB_ACCESS_TOKEN

  // change to temporary directory
  await fs.remove(tempFolder)
  await fs.ensureDir(tempFolder)

  // change to temp dir
  process.chdir(tempFolder)

  // download repo
  await clone(sourceRepo, sourceFolderName, 'master', token)
  const sourceFolder = path.join(tempFolder, sourceFolderName)

  const destinationRepo = await exec(`git config --get remote.origin.url`)
  await clone(destinationRepo, destinationFolderName, 'gh-pages')
  const destinationFolder = path.join(tempFolder, destinationFolderName)

  const indexFileSrc = path.join(destinationFolder, 'Home.md')
  const indexFileDest = path.join(destinationFolder, 'index.md')

  // copy everything from source to destination
  const sourceFiles = await globby('*.md', { cwd: sourceFolder }) || []
  const copyInstructions = sourceFiles.map(src => ({
    from: path.join(sourceFolder, src),
    to: path.join(destinationFolder, src)
  }))
  const replaceRegex = new RegExp(
    sourceFiles
      .map(src => src.replace('.md', ''))
      .map(src => `[${src}](${src})`)
      .map(escapeRegExp)
      .join('|'),
    'gi'
  )

  const backToHome = '[**◀ Home**](./)\n\n'
  copyInstructions.forEach(instruction => {
    const src = fs.readFileSync(instruction.from, 'utf8')

    // replaces links
    let dest = src.replace(replaceRegex, (match) => {
      return match.replace(')', '.html)')
    })

    // add back link
    if (instruction.to !== indexFileSrc) {
      dest = `${backToHome}\n${dest}`
    }

    fs.writeFileSync(instruction.to, dest)
  })

  // rename Home to index
  await fs.remove(indexFileDest)
  await fs.move(indexFileSrc, indexFileDest)

  // generate docs
  await xsddoc()
  const docsFilesSrc = path.join(__dirname, '..', 'xsddoc', '.tmp')
  const docsFilesDest = path.join(destinationFolder, 'docs')
  await fs.remove(docsFilesDest)
  await fs.copy(docsFilesSrc, docsFilesDest)

  // commit changes
  process.chdir(destinationFolder)
  await exec(`git add -A *.md`, loudExecConfig)
  await exec(`git add -A ${docsFilesDest}/*`, loudExecConfig)
  const commitCommand = 'git commit -m "Updating posts and docs"'
  try {
    await exec(commitCommand, loudExecConfig)
    await push(destinationRepo, token)
  } catch (error) {
    if (!error.result || !error.result.command.match(commitCommand)) {
      throw error
    }
    // don't fail, because if there was nothing to commit, it's ok to end up here
    log.info('no changes found')
  }
}

update()

// make sure, we're exit with code:1 for undhandled rejections
process.on('unhandledRejection', error => {
  log.failure(error.message, '\nDetails:\n', error, '\n\n')
  process.exitCode = 1
})
