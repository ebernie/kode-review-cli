import { describe, it, expect } from 'vitest'
import {
  getFileType,
  getStrategyForFile,
  extractPriorityQueries,
  extractQueriesUsingStrategy,
  generateRelatedFilePaths,
  typescriptStrategy,
  javascriptStrategy,
  pythonStrategy,
  goStrategy,
  cssStrategy,
  scssStrategy,
  genericStrategy,
  FILE_TYPE_STRATEGIES,
} from '../file-type-strategies.js'

describe('getFileType', () => {
  it('identifies TypeScript files', () => {
    expect(getFileType('src/utils.ts')).toBe('typescript')
    expect(getFileType('components/Button.tsx')).toBe('typescript')
  })

  it('identifies JavaScript files', () => {
    expect(getFileType('src/utils.js')).toBe('javascript')
    expect(getFileType('components/Button.jsx')).toBe('javascript')
    expect(getFileType('lib/module.mjs')).toBe('javascript')
    expect(getFileType('lib/module.cjs')).toBe('javascript')
  })

  it('identifies Python files', () => {
    expect(getFileType('src/utils.py')).toBe('python')
    expect(getFileType('tests/test_utils.py')).toBe('python')
  })

  it('identifies Go files', () => {
    expect(getFileType('main.go')).toBe('go')
    expect(getFileType('pkg/handlers/user.go')).toBe('go')
  })

  it('identifies CSS files', () => {
    expect(getFileType('styles/main.css')).toBe('css')
  })

  it('identifies SCSS files', () => {
    expect(getFileType('styles/main.scss')).toBe('scss')
    expect(getFileType('styles/_variables.sass')).toBe('scss')
  })

  it('returns generic for unknown file types', () => {
    expect(getFileType('data.json')).toBe('generic')
    expect(getFileType('config.yaml')).toBe('generic')
    expect(getFileType('README.md')).toBe('generic')
  })
})

describe('getStrategyForFile', () => {
  it('returns TypeScript strategy for .ts files', () => {
    expect(getStrategyForFile('src/utils.ts')).toBe(typescriptStrategy)
  })

  it('returns JavaScript strategy for .js files', () => {
    expect(getStrategyForFile('src/utils.js')).toBe(javascriptStrategy)
  })

  it('returns Python strategy for .py files', () => {
    expect(getStrategyForFile('main.py')).toBe(pythonStrategy)
  })

  it('returns Go strategy for .go files', () => {
    expect(getStrategyForFile('main.go')).toBe(goStrategy)
  })

  it('returns CSS strategy for .css files', () => {
    expect(getStrategyForFile('styles.css')).toBe(cssStrategy)
  })

  it('returns SCSS strategy for .scss files', () => {
    expect(getStrategyForFile('styles.scss')).toBe(scssStrategy)
  })

  it('returns generic strategy for unknown files', () => {
    expect(getStrategyForFile('data.json')).toBe(genericStrategy)
  })
})

describe('extractPriorityQueries - TypeScript', () => {
  it('extracts type annotations', () => {
    const code = `
      const user: UserData = fetchUser()
      const item: ItemType;
      let result: ProcessResult = undefined;
    `
    const queries = extractPriorityQueries(code, typescriptStrategy)
    expect(queries.some(q => q.query.includes('UserData'))).toBe(true)
    expect(queries.some(q => q.query.includes('ItemType'))).toBe(true)
    expect(queries.some(q => q.query.includes('ProcessResult'))).toBe(true)
  })

  it('extracts extends clause', () => {
    const code = `
      class UserService extends BaseService {
        constructor() {
          super()
        }
      }
    `
    const queries = extractPriorityQueries(code, typescriptStrategy)
    expect(queries.some(q => q.query.includes('BaseService'))).toBe(true)
  })

  it('extracts implements clause', () => {
    const code = `
      class PaymentHandler implements PaymentProcessor {
        process() {}
      }
    `
    const queries = extractPriorityQueries(code, typescriptStrategy)
    expect(queries.some(q => q.query.includes('PaymentProcessor'))).toBe(true)
  })

  it('extracts named imports', () => {
    const code = `
      import { UserService, ConfigManager } from './services'
    `
    const queries = extractPriorityQueries(code, typescriptStrategy)
    expect(queries.some(q => q.query.includes('UserService'))).toBe(true)
  })
})

describe('extractPriorityQueries - Python', () => {
  it('extracts class inheritance', () => {
    const code = `
      class MyHandler(BaseHandler):
          pass
    `
    const queries = extractPriorityQueries(code, pythonStrategy)
    expect(queries.some(q => q.query.includes('BaseHandler'))).toBe(true)
  })

  it('extracts decorator usage', () => {
    const code = `
      @dataclass
      class User:
          name: str

      @router.get("/users")
      def get_users():
          pass
    `
    const queries = extractPriorityQueries(code, pythonStrategy)
    expect(queries.some(q => q.query.includes('dataclass'))).toBe(true)
    expect(queries.some(q => q.query.includes('router'))).toBe(true)
  })

  it('extracts type hints', () => {
    const code = `
      def process_items(items: List[Item]) -> ProcessedResult:
          pass

      user: UserModel = get_user()
    `
    const queries = extractPriorityQueries(code, pythonStrategy)
    expect(queries.some(q => q.query.includes('ProcessedResult'))).toBe(true)
    expect(queries.some(q => q.query.includes('UserModel'))).toBe(true)
  })
})

describe('extractPriorityQueries - Go', () => {
  it('extracts interface definitions', () => {
    const code = `
      type UserRepository interface {
          FindById(id string) (*User, error)
      }
    `
    const queries = extractPriorityQueries(code, goStrategy)
    expect(queries.some(q => q.query.includes('UserRepository'))).toBe(true)
  })

  it('extracts method receivers', () => {
    const code = `
      func (s *UserService) GetUser(id string) (*User, error) {
          return s.repo.FindById(id)
      }
    `
    const queries = extractPriorityQueries(code, goStrategy)
    expect(queries.some(q => q.query.includes('UserService'))).toBe(true)
  })
})

describe('extractPriorityQueries - CSS/SCSS', () => {
  it('extracts CSS variable usage', () => {
    const code = `
      .button {
        background: var(--primary-color);
        color: var(--text-color);
      }
    `
    const queries = extractPriorityQueries(code, cssStrategy)
    expect(queries.some(q => q.query.includes('primary-color'))).toBe(true)
    expect(queries.some(q => q.query.includes('text-color'))).toBe(true)
  })

  it('extracts SCSS variable usage', () => {
    const code = `
      .container {
        max-width: $container-width;
        padding: $spacing-md;
      }
    `
    const queries = extractPriorityQueries(code, scssStrategy)
    expect(queries.some(q => q.query.includes('container-width'))).toBe(true)
    expect(queries.some(q => q.query.includes('spacing-md'))).toBe(true)
  })

  it('extracts mixin includes', () => {
    const code = `
      .card {
        @include flex-center;
        @include responsive-padding;
      }
    `
    const queries = extractPriorityQueries(code, scssStrategy)
    expect(queries.some(q => q.query.includes('flex-center'))).toBe(true)
    expect(queries.some(q => q.query.includes('responsive-padding'))).toBe(true)
  })

  it('extracts extend directives', () => {
    const code = `
      .alert {
        @extend .base-component;
        @extend %placeholder-style;
      }
    `
    const queries = extractPriorityQueries(code, scssStrategy)
    expect(queries.some(q => q.query.includes('.base-component'))).toBe(true)
    expect(queries.some(q => q.query.includes('%placeholder-style'))).toBe(true)
  })
})

describe('extractQueriesUsingStrategy', () => {
  it('extracts interface names from TypeScript', () => {
    const code = `
      interface UserData {
        id: string
        name: string
      }
      type Config = { key: string }
    `
    const queries = extractQueriesUsingStrategy(code, typescriptStrategy)
    expect(queries).toContain('UserData')
    expect(queries).toContain('Config')
  })

  it('extracts class and function names from Python', () => {
    const code = `
      class DataProcessor:
          def process(self, data):
              pass

      async def fetch_data():
          pass
    `
    const queries = extractQueriesUsingStrategy(code, pythonStrategy)
    expect(queries).toContain('DataProcessor')
    expect(queries).toContain('process')
    expect(queries).toContain('fetch_data')
  })

  it('extracts function and type names from Go', () => {
    const code = `
      func ProcessData(data []byte) error {
          return nil
      }

      type Config struct {
          Port int
      }
    `
    const queries = extractQueriesUsingStrategy(code, goStrategy)
    expect(queries).toContain('ProcessData')
    expect(queries).toContain('Config')
  })

  it('extracts selectors and variables from SCSS', () => {
    const code = `
      $primary-color: #007bff;

      @mixin flex-center {
        display: flex;
        align-items: center;
      }

      .button-primary {
        background: $primary-color;
      }
    `
    const queries = extractQueriesUsingStrategy(code, scssStrategy)
    expect(queries).toContain('primary-color')
    expect(queries).toContain('flex-center')
    expect(queries).toContain('button-primary')
  })
})

describe('generateRelatedFilePaths - TypeScript', () => {
  it('generates type definition paths', () => {
    const paths = generateRelatedFilePaths('src/services/user.ts', typescriptStrategy)
    expect(paths).toContain('src/services/user.d.ts')
    expect(paths).toContain('src/services/user.types.ts')
    expect(paths).toContain('src/services/user/types.ts')
  })

  it('generates index file paths', () => {
    const paths = generateRelatedFilePaths('src/services/user.ts', typescriptStrategy)
    expect(paths).toContain('src/services/index.ts')
    expect(paths).toContain('src/services/index.tsx')
  })
})

describe('generateRelatedFilePaths - Python', () => {
  it('generates __init__.py paths', () => {
    const paths = generateRelatedFilePaths('src/services/user.py', pythonStrategy)
    expect(paths).toContain('src/services/__init__.py')
  })

  it('generates base module paths', () => {
    const paths = generateRelatedFilePaths('src/handlers/user.py', pythonStrategy)
    expect(paths).toContain('src/handlers/base.py')
    expect(paths).toContain('src/handlers/abc.py')
    expect(paths).toContain('src/handlers/interfaces.py')
  })

  it('generates conftest.py paths', () => {
    const paths = generateRelatedFilePaths('tests/unit/test_user.py', pythonStrategy)
    expect(paths.some(p => p.includes('conftest.py'))).toBe(true)
  })
})

describe('generateRelatedFilePaths - Go', () => {
  it('generates doc.go paths', () => {
    const paths = generateRelatedFilePaths('pkg/handlers/user.go', goStrategy)
    expect(paths).toContain('pkg/handlers/doc.go')
  })

  it('generates interface and types file paths', () => {
    const paths = generateRelatedFilePaths('pkg/services/user.go', goStrategy)
    expect(paths).toContain('pkg/services/interfaces.go')
    expect(paths).toContain('pkg/services/types.go')
    expect(paths).toContain('pkg/services/contract.go')
  })
})

describe('generateRelatedFilePaths - SCSS', () => {
  it('generates variables file paths', () => {
    const paths = generateRelatedFilePaths('styles/components/button.scss', scssStrategy)
    expect(paths).toContain('styles/components/_variables.scss')
    expect(paths).toContain('styles/components/variables.scss')
  })

  it('generates mixins file paths', () => {
    const paths = generateRelatedFilePaths('styles/components/card.scss', scssStrategy)
    expect(paths).toContain('styles/components/_mixins.scss')
    expect(paths).toContain('styles/components/mixins.scss')
  })

  it('generates base styles paths', () => {
    const paths = generateRelatedFilePaths('styles/pages/home.scss', scssStrategy)
    expect(paths).toContain('styles/pages/_base.scss')
    expect(paths).toContain('styles/pages/base.scss')
  })
})

describe('FILE_TYPE_STRATEGIES registry', () => {
  it('contains all expected strategies', () => {
    expect(FILE_TYPE_STRATEGIES.typescript).toBe(typescriptStrategy)
    expect(FILE_TYPE_STRATEGIES.javascript).toBe(javascriptStrategy)
    expect(FILE_TYPE_STRATEGIES.python).toBe(pythonStrategy)
    expect(FILE_TYPE_STRATEGIES.go).toBe(goStrategy)
    expect(FILE_TYPE_STRATEGIES.css).toBe(cssStrategy)
    expect(FILE_TYPE_STRATEGIES.scss).toBe(scssStrategy)
    expect(FILE_TYPE_STRATEGIES.generic).toBe(genericStrategy)
  })

  it('TypeScript strategy has correct extensions', () => {
    expect(typescriptStrategy.extensions).toContain('.ts')
    expect(typescriptStrategy.extensions).toContain('.tsx')
  })

  it('JavaScript strategy has correct extensions', () => {
    expect(javascriptStrategy.extensions).toContain('.js')
    expect(javascriptStrategy.extensions).toContain('.jsx')
    expect(javascriptStrategy.extensions).toContain('.mjs')
    expect(javascriptStrategy.extensions).toContain('.cjs')
  })

  it('Python strategy has correct extensions', () => {
    expect(pythonStrategy.extensions).toContain('.py')
  })

  it('Go strategy has correct extensions', () => {
    expect(goStrategy.extensions).toContain('.go')
  })

  it('CSS strategy has correct extensions', () => {
    expect(cssStrategy.extensions).toContain('.css')
  })

  it('SCSS strategy has correct extensions', () => {
    expect(scssStrategy.extensions).toContain('.scss')
    expect(scssStrategy.extensions).toContain('.sass')
  })

  it('strategies have appropriate flags for their language', () => {
    expect(typescriptStrategy.searchTypeDefinitions).toBe(true)
    expect(typescriptStrategy.searchBaseClasses).toBe(true)
    expect(typescriptStrategy.searchImportedModules).toBe(true)

    expect(pythonStrategy.searchTypeDefinitions).toBe(false)
    expect(pythonStrategy.searchBaseClasses).toBe(true)
    expect(pythonStrategy.searchImportedModules).toBe(true)

    expect(goStrategy.searchTypeDefinitions).toBe(false)
    expect(goStrategy.searchBaseClasses).toBe(false) // Go uses composition
    expect(goStrategy.searchImportedModules).toBe(true)

    expect(cssStrategy.searchTypeDefinitions).toBe(false)
    expect(cssStrategy.searchBaseClasses).toBe(false)
    expect(cssStrategy.searchImportedModules).toBe(false)
  })
})
