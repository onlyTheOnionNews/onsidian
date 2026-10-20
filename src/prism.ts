// Prism with common languages, loaded lazily by loadPrism(). Components register on the global Prism.
// ponytail: fixed language list (no network autoloader). Add components here when users ask for more.
import Prism from 'prismjs';
import 'prismjs/components/prism-markup-templating';
import 'prismjs/components/prism-typescript';
import 'prismjs/components/prism-jsx';
import 'prismjs/components/prism-tsx';
import 'prismjs/components/prism-python';
import 'prismjs/components/prism-bash';
import 'prismjs/components/prism-json';
import 'prismjs/components/prism-yaml';
import 'prismjs/components/prism-markdown';
import 'prismjs/components/prism-java';
import 'prismjs/components/prism-c';
import 'prismjs/components/prism-cpp';
import 'prismjs/components/prism-csharp';
import 'prismjs/components/prism-go';
import 'prismjs/components/prism-rust';
import 'prismjs/components/prism-sql';
import 'prismjs/components/prism-ruby';
import 'prismjs/components/prism-php';
import 'prismjs/components/prism-swift';
import 'prismjs/components/prism-kotlin';
import 'prismjs/components/prism-toml';
import 'prismjs/components/prism-diff';
import 'prismjs/components/prism-latex';

// Common aliases people write after ``` .
Object.assign(Prism.languages, { sh: Prism.languages.bash, shell: Prism.languages.bash, zsh: Prism.languages.bash, ts: Prism.languages.typescript, js: Prism.languages.javascript, py: Prism.languages.python, yml: Prism.languages.yaml, md: Prism.languages.markdown, 'c++': Prism.languages.cpp, cs: Prism.languages.csharp, rs: Prism.languages.rust, rb: Prism.languages.ruby, kt: Prism.languages.kotlin, tex: Prism.languages.latex, html: Prism.languages.markup, xml: Prism.languages.markup });

export default Prism;
