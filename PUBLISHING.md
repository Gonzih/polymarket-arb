# Publishing Notes

## npm

Published to npm as `polymarket-arb`. To install:
```bash
npm install -g polymarket-arb
# or
npx polymarket-arb --paper
```

## PyPI

PyPI publish requires `twine` and a valid PyPI token. To publish manually:
```bash
pip install build twine
python -m build
twine upload dist/*
```

If credentials are not available in the current environment, skip PyPI publish.
The package is fully functional via direct pip install from git:
```bash
pip install git+https://github.com/Gonzih/polymarket-arb.git
```

Or install the npm package which will auto-install the Python package:
```bash
npx polymarket-arb --paper
```
