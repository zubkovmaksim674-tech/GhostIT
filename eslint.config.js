const eslintConfig = [
  {
    ignores: ['node_modules/**', 'dist/**', 'build/**', 'renderer/qrcode.min.js']
  },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        console: 'readonly',
        AudioContext: 'readonly',
        MediaStream: 'readonly',
        SpeechSynthesisUtterance: 'readonly',
        performance: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        Float32Array: 'readonly',
        URL: 'readonly',
        Response: 'readonly',
        fetch: 'readonly',
        AbortController: 'readonly',
        QRCode: 'readonly',
        require: 'readonly',
        module: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        AbortSignal: 'readonly',
        TextDecoder: 'readonly'
      }
    },
    rules: {
      'no-unused-vars': ['warn', { args: 'none', varsIgnorePattern: '^_' }],
      'no-undef': 'error',
      'no-unreachable': 'warn',
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-fallthrough': 'warn',
      'no-unused-expressions': 'warn'
    }
  }
];

module.exports = eslintConfig;