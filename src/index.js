import path from 'path';
import parsePath from 'path-parse';

export default function ({ Plugin, types: t }) {
  const parentDir = path.resolve(path.join(__dirname, '..', '..'));
  function resolvePathConservatively(specifiedPath, filePath) {
    if (specifiedPath[0] === '.') {
      throw new Error(
        `Relative path like ${specifiedPath} is only allowed if ` +
        `babel-plugin-react-transform is inside a node_modules folder.`
      );
    }
    return specifiedPath;
  }
  function resolvePathAssumingWeAreInNodeModules(specifiedPath, filePath) {
    if (specifiedPath[0] === '.') {
      return '.' + path.sep + path.relative(
        path.dirname(filePath),
        path.resolve(path.join(parentDir, '..', specifiedPath))
      );
    }
    return specifiedPath;
  }
  const resolvePath = path.basename(parentDir) === 'node_modules' ?
    resolvePathAssumingWeAreInNodeModules :
    resolvePathConservatively;

  const depthKey = '__reactTransformDepth';
  const recordsKey = '__reactTransformRecords';
  const wrapComponentIdKey = '__reactTransformWrapComponentId';

  function isRenderMethod(member) {
    return member.kind === 'method' &&
           member.key.name === 'render';
  }

  /**
   * Does this class have a render function?
   */
  function isComponentishClass(cls) {
    return cls.body.body.filter(isRenderMethod).length > 0;
  }

  const isCreateClassCallExpression = t.buildMatchMemberExpression('React.createClass');
  /**
   * Does this node look like a createClass() call?
   */
  function isCreateClass(node) {
    if (!node || !t.isCallExpression(node)) {
      return false;
    }
    if (!isCreateClassCallExpression(node.callee)) {
      return false;
    }
    const args = node.arguments;
    if (args.length !== 1) {
      return false;
    }
    const first = args[0];
    if (!t.isObjectExpression(first)) {
      return false;
    }
    return true;
  }

  /**
   * Infers a displayName from either a class node, or a createClass() call node.
   */
  function findDisplayName(node) {
    if (node.id) {
      return node.id.name;
    }
    if (!node.arguments) {
      return;
    }
    const props = node.arguments[0].properties;
    for (let i = 0; i < props.length; i++) {
      const prop = props[i];
      const key = t.toComputedKey(prop);
      if (t.isLiteral(key, { value: 'displayName' })) {
        return prop.value.value;
      }
    }
  }

  /**
   * Enforces plugin options to be defined and returns them.
   */
  function getPluginOptions(file) {
    if (!file.opts || !file.opts.extra) {
      return;
    }
    const pluginOptions = file.opts.extra['react-transform'];
    if (!Array.isArray(pluginOptions)) {
      throw new Error(
        'babel-plugin-react-transform requires that you specify ' +
        'extras["react-transform"] in .babelrc ' +
        'or in your Babel Node API call options, and that it is an array.'
      );
    }
    return pluginOptions;
  }

  /**
   * Creates a record about us having visited a valid React component.
   * Such records will later be merged into a single object.
   */
  function createComponentRecord(node, scope, file, state) {
    const displayName = findDisplayName(node) || undefined;
    const uniqueId = scope.generateUidIdentifier(
      '$' + (displayName || 'Unknown')
    ).name;

    let props = [];
    if (typeof displayName === 'string') {
      props.push(t.property('init',
        t.identifier('displayName'),
        t.literal(displayName)
      ));
    }
    if (state[depthKey] > 0) {
      props.push(t.property('init',
        t.identifier('isInFunction'),
        t.literal(true)
      ));
    }

    return [uniqueId, t.objectExpression(props)];
  }

  /**
   * Memorizes the fact that we have visited a valid component in the plugin state.
   * We will later retrieved memorized records to compose an object out of them.
   */
  function addComponentRecord(node, scope, file, state) {
    const [uniqueId, definition] = createComponentRecord(node, scope, file, state);
    state[recordsKey] = state[recordsKey] || [];
    state[recordsKey].push(t.property('init',
      t.identifier(uniqueId),
      definition
    ));
    return uniqueId;
  }

  /**
   * Have we visited any components so far?
   */
  function foundComponentRecords(state) {
    const records = state[recordsKey];
    return records && records.length > 0;
  }

  /**
   * Turns all component records recorded so far, into a variable.
   */
  function defineComponentRecords(scope, state) {
    const records = state[recordsKey];
    state[recordsKey] = [];

    const id = scope.generateUidIdentifier('components');
    return [id, t.variableDeclaration('var', [
      t.variableDeclarator(id, t.objectExpression(records))
    ])];
  }

  /**
   * Imports and calls a particular transformation target function.
   * You may specify several such transformations, so they are handled separately.
   */
  function defineInitTransformCall(scope, file, recordsId, targetOptions) {
    const id = scope.generateUidIdentifier('reactComponentWrapper');
    const { target, imports = [], locals = [] } = targetOptions;
    const { filename } = file.opts;

    function isSameAsFileBeingProcessed(importPath) {
      const { dir, base, ext, name } = parsePath(resolvePath(importPath, filename));
      return dir === '.' && name === parsePath(filename).name;
    }

    if (imports.some(isSameAsFileBeingProcessed)) {
      return;
    }

    return [id, t.variableDeclaration('var', [
      t.variableDeclarator(id,
        t.callExpression(file.addImport(resolvePath(target, filename)), [
          t.objectExpression([
            t.property('init', t.identifier('filename'), t.literal(filename)),
            t.property('init', t.identifier('components'), recordsId),
            t.property('init', t.identifier('locals'), t.arrayExpression(
              locals.map(local => t.identifier(local))
            )),
            t.property('init', t.identifier('imports'), t.arrayExpression(
              imports.map(imp => file.addImport(resolvePath(imp, filename), imp, 'absolute'))
            ))
          ])
        ])
      )
    ])];
  }

  /**
   * Defines the function that calls every transform.
   * This is the function every component will be wrapped with.
   */
  function defineWrapComponent(wrapComponentId, initTransformIds) {
    return t.functionDeclaration(wrapComponentId, [t.identifier('uniqueId')],
      t.blockStatement([
        t.returnStatement(
          t.functionExpression(null, [t.identifier('ReactClass')], t.blockStatement([
            t.returnStatement(
              initTransformIds.reduce((composed, initTransformId) =>
                t.callExpression(initTransformId, [composed, t.identifier('uniqueId')]),
                t.identifier('ReactClass')
              )
            )
          ]))
        )
      ])
    );
  }

  return new Plugin('babel-plugin-react-transform', {
    visitor: {
      Function: {
        enter(node, parent, scope, file) {
          if (!this.state[depthKey]) {
            this.state[depthKey] = 0;
          }
          this.state[depthKey]++;
        },
        exit(node, parent, scope, file) {
          this.state[depthKey]--;
        }
      },

      Class(node, parent, scope, file) {
        if (!isComponentishClass(node)) {
          return;
        }

        const wrapReactComponentId = this.state[wrapComponentIdKey];
        const uniqueId = addComponentRecord(node, scope, file, this.state);

        node.decorators = node.decorators || [];
        node.decorators.push(t.decorator(
          t.callExpression(wrapReactComponentId, [t.literal(uniqueId)])
        ));
      },

      CallExpression: {
        exit(node, parent, scope, file) {
          if (!isCreateClass(node)) {
            return;
          }

          const wrapReactComponentId = this.state[wrapComponentIdKey];
          const uniqueId = addComponentRecord(node, scope, file, this.state);

          return t.callExpression(
            t.callExpression(wrapReactComponentId, [t.literal(uniqueId)]),
            [node]
          );
        }
      },

      Program: {
        enter(node, parent, scope, file) {
          this.state[wrapComponentIdKey] = scope.generateUidIdentifier('wrapComponent');
        },

        exit(node, parent, scope, file) {
          if (!foundComponentRecords(this.state)) {
            return;
          }

          // Generate a variable holding component records
          const allTransformOptions = getPluginOptions(file);
          const [recordsId, recordsVar] = defineComponentRecords(scope, this.state);

          // Import transformation functions and initialize them
          const initTransformCalls = allTransformOptions.map(transformOptions =>
            defineInitTransformCall(scope, file, recordsId, transformOptions)
          ).filter(Boolean);
          const initTransformIds = initTransformCalls.map(c => c[0]);
          const initTransformVars = initTransformCalls.map(c => c[1]);

          // Create one uber function calling each transformation
          const wrapComponentId = this.state[wrapComponentIdKey];
          const wrapComponent = defineWrapComponent(wrapComponentId, initTransformIds);

          return t.program([
            recordsVar,
            ...initTransformVars,
            wrapComponent,
            ...node.body
          ]);
        }
      }
    }
  });
}
