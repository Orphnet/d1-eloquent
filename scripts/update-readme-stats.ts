import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const README_PATH = join(ROOT, 'README.md')
const DOCS_INDEX_PATH = join(ROOT, 'docs', 'index.md')
const TEST_RESULTS_PATH = join(ROOT, 'test-results.json')
const COVERAGE_PATH = join(ROOT, 'coverage', 'coverage-summary.json')

interface TestResults {
  numTotalTestSuites: number
  numPassedTestSuites: number
  numFailedTestSuites: number
  numTotalTests: number
  numPassedTests: number
  numFailedTests: number
  success: boolean
}

interface CoverageMetric {
  total: number
  covered: number
  skipped: number
  pct: number
}

interface CoverageSummary {
  total: {
    statements: CoverageMetric
    branches: CoverageMetric
    functions: CoverageMetric
    lines: CoverageMetric
  }
}

function coverageColor(pct: number): string {
  if (pct >= 90) return 'brightgreen'
  if (pct >= 80) return 'green'
  if (pct >= 70) return 'yellowgreen'
  if (pct >= 60) return 'yellow'
  if (pct >= 50) return 'orange'
  return 'red'
}

function testColor(passed: number, total: number): string {
  if (passed === total) return 'brightgreen'
  if (passed > total * 0.9) return 'yellow'
  return 'red'
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function replaceBetweenMarkers(content: string, startMarker: string, endMarker: string, replacement: string): string {
  const regex = new RegExp(`(${escapeRegex(startMarker)})[\\s\\S]*?(${escapeRegex(endMarker)})`)
  return content.replace(regex, `$1\n${replacement}\n$2`)
}

// Read data
let testResults: TestResults | null = null
if (existsSync(TEST_RESULTS_PATH)) {
  testResults = JSON.parse(readFileSync(TEST_RESULTS_PATH, 'utf-8'))
}

let coverage: CoverageSummary | null = null
if (existsSync(COVERAGE_PATH)) {
  coverage = JSON.parse(readFileSync(COVERAGE_PATH, 'utf-8'))
}

if (!testResults && !coverage) {
  console.log('No test results or coverage data found. Run tests first.')
  process.exit(0)
}

// Build badge data
interface Badge { alt: string; src: string; href: string }
const badgeData: Badge[] = [
  { alt: 'npm', src: 'https://img.shields.io/npm/v/@orphnet/d1-eloquent?color=blue', href: 'https://www.npmjs.com/package/@orphnet/d1-eloquent' },
]

if (testResults) {
  const { numPassedTests, numTotalTests } = testResults
  const color = testColor(numPassedTests, numTotalTests)
  const label = numPassedTests === numTotalTests
    ? `${numPassedTests}_passed`
    : `${numPassedTests}%2F${numTotalTests}_passed`
  badgeData.push({ alt: 'Tests', src: `https://img.shields.io/badge/tests-${label}-${color}`, href: 'https://github.com/orphnet/d1-eloquent/actions' })
}

if (coverage) {
  const pct = coverage.total.statements.pct
  const color = coverageColor(pct)
  badgeData.push({ alt: 'Coverage', src: `https://img.shields.io/badge/coverage-${pct}%25-${color}`, href: 'https://github.com/orphnet/d1-eloquent/actions' })
}

const toMarkdown = (b: Badge) => `[![${b.alt}](${b.src})](${b.href})`
const toHtml = (b: Badge) => `<a href="${b.href}"><img src="${b.src}" alt="${b.alt}"></a>`

// Build summary table
const summaryLines: string[] = []
summaryLines.push('| Metric | Result |')
summaryLines.push('|--------|--------|')

if (testResults) {
  summaryLines.push(`| Tests | ${testResults.numPassedTests} passed, ${testResults.numFailedTests} failed (${testResults.numTotalTests} total) |`)
  summaryLines.push(`| Suites | ${testResults.numPassedTestSuites} passed (${testResults.numTotalTestSuites} total) |`)
}

if (coverage) {
  const { statements, branches, functions, lines } = coverage.total
  summaryLines.push(`| Statements | ${statements.pct}% |`)
  summaryLines.push(`| Branches | ${branches.pct}% |`)
  summaryLines.push(`| Functions | ${functions.pct}% |`)
  summaryLines.push(`| Lines | ${lines.pct}% |`)
}

// Build per-file coverage table
const coverageDetailLines: string[] = []
if (coverage) {
  const summary = JSON.parse(readFileSync(COVERAGE_PATH, 'utf-8')) as Record<string, { statements: CoverageMetric; branches: CoverageMetric; functions: CoverageMetric; lines: CoverageMetric }>
  coverageDetailLines.push('| File | Statements | Branches | Functions | Lines |')
  coverageDetailLines.push('|------|-----------|----------|-----------|-------|')
  for (const [filePath, metrics] of Object.entries(summary)) {
    if (filePath === 'total') continue
    const short = filePath.replace(ROOT + '/', '')
    coverageDetailLines.push(`| \`${short}\` | ${metrics.statements.pct}% | ${metrics.branches.pct}% | ${metrics.functions.pct}% | ${metrics.lines.pct}% |`)
  }
  coverageDetailLines.push('')
  const { statements, branches, functions, lines } = coverage.total
  coverageDetailLines.push(`| **Total** | **${statements.pct}%** | **${branches.pct}%** | **${functions.pct}%** | **${lines.pct}%** |`)
}

// Build per-file test results table
const testDetailLines: string[] = []
if (testResults) {
  const raw = JSON.parse(readFileSync(TEST_RESULTS_PATH, 'utf-8')) as { testResults: Array<{ name: string; status: string; assertionResults: Array<{ fullName: string; status: string }> }> }
  testDetailLines.push('| Suite | Tests | Status |')
  testDetailLines.push('|-------|-------|--------|')
  for (const suite of raw.testResults) {
    const shortName = suite.name.replace(ROOT + '/', '')
    const passed = suite.assertionResults.filter(t => t.status === 'passed').length
    const total = suite.assertionResults.length
    const icon = passed === total ? '✅' : '❌'
    testDetailLines.push(`| \`${shortName}\` | ${passed}/${total} | ${icon} |`)
  }
}

// Generate full docs coverage page
const DOCS_COVERAGE_PATH = join(ROOT, 'docs', 'guide', 'test-coverage.md')
const docsPage: string[] = [
  '---',
  'outline: [2, 3]',
  '---',
  '',
  '# Test Coverage',
  '',
  `<div style="display:flex;gap:8px;margin:1rem 0">`,
  `<!-- BADGES:START -->`,
  badgeData.map(toHtml).join(' '),
  `<!-- BADGES:END -->`,
  `</div>`,
  '',
]
if (testResults) {
  docsPage.push(
    '## Test Results',
    '',
    `**${testResults.numPassedTests}** tests passing across **${testResults.numTotalTestSuites}** suites.`,
    '',
    ...testDetailLines,
    '',
  )
}
if (coverageDetailLines.length) {
  docsPage.push(
    '## Coverage',
    '',
    `Thresholds: statements 95%, branches 90%, functions 95%, lines 95%.`,
    '',
    ...coverageDetailLines,
    '',
  )
}
docsPage.push(
  '---',
  '',
  '*Auto-generated by `bun run test:stats`. Do not edit manually.*',
)
writeFileSync(DOCS_COVERAGE_PATH, docsPage.join('\n'))

// Update badge markers in README and docs index
const badgeMd = badgeData.map(toMarkdown).join(' ')
const badgeHtml = badgeData.map(toHtml).join(' ')
const summaryContent = summaryLines.join('\n')

for (const filePath of [README_PATH, DOCS_INDEX_PATH]) {
  if (!existsSync(filePath)) continue
  const isHtml = filePath === DOCS_INDEX_PATH
  let content = readFileSync(filePath, 'utf-8')
  if (content.includes('<!-- BADGES:START -->')) {
    // For HTML files (docs), avoid extra newlines that cause VitePress to create block elements
    const replacement = isHtml ? badgeHtml : badgeMd
    const regex = new RegExp(`(<!-- BADGES:START -->)[\\s\\S]*?(<!-- BADGES:END -->)`)
    content = content.replace(regex, `$1\n${replacement}\n$2`)
  }
  if (content.includes('<!-- TEST-SUMMARY:START -->')) {
    content = replaceBetweenMarkers(content, '<!-- TEST-SUMMARY:START -->', '<!-- TEST-SUMMARY:END -->', summaryContent)
  }
  writeFileSync(filePath, content)
}

// Keep the landing-page marketing components in lockstep with the same
// numbers. These files only exist in the dev repo (the public repo ships
// this script without docs/.vitepress), so skip silently when absent.
const MARKETING_DIR = join(ROOT, 'docs', '.vitepress', 'theme', 'components')
const HERO_PATH = join(MARKETING_DIR, 'MarketingHero.vue')
const STATS_COMPONENT_PATH = join(MARKETING_DIR, 'MarketingStats.vue')

const testCount = testResults?.numPassedTests
const linePct = coverage ? Number(coverage.total.lines.pct.toFixed(1)) : undefined

if (existsSync(HERO_PATH)) {
  let hero = readFileSync(HERO_PATH, 'utf-8')
  if (testCount !== undefined) {
    const pretty = testCount.toLocaleString('en-US')
    // Vitest trust-pill description: "1,471 tests with a 90% branch-coverage gate..."
    hero = hero.replace(/[\d,]+ tests with/, `${pretty} tests with`)
    // Metric chip value: <span class="chip__value">1,471</span>
    hero = hero.replace(/(<span class="chip__value">)[\d,]+(<\/span>)/, `$1${pretty}$2`)
  }
  if (linePct !== undefined) {
    // Metric chip note: "97.9% line coverage"
    hero = hero.replace(/[\d.]+% line coverage/, `${linePct}% line coverage`)
  }
  writeFileSync(HERO_PATH, hero)
  console.log('MarketingHero.vue updated with test stats.')
}

if (existsSync(STATS_COMPONENT_PATH)) {
  let statsComponent = readFileSync(STATS_COMPONENT_PATH, 'utf-8')
  if (testCount !== undefined) {
    statsComponent = statsComponent.replace(
      /(\{ target: )[\d.]+(, suffix: '\+', label: 'Tests passing')/,
      `$1${testCount}$2`,
    )
  }
  if (linePct !== undefined) {
    statsComponent = statsComponent.replace(
      /(\{ target: )[\d.]+(, suffix: '%', label: 'Line coverage')/,
      `$1${linePct}$2`,
    )
  }
  writeFileSync(STATS_COMPONENT_PATH, statsComponent)
  console.log('MarketingStats.vue updated with test stats.')
}

console.log('README.md + docs/index.md updated with test stats.')
if (testResults) {
  console.log(`  Tests: ${testResults.numPassedTests}/${testResults.numTotalTests} passed`)
}
if (coverage) {
  console.log(`  Coverage: ${coverage.total.statements.pct}% statements`)
}
