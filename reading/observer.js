import { Atom, Reaction, extras } from "mobx"
import React, { Component } from "react"
import { findDOMNode as baseFindDOMNode } from "react-dom"
import EventEmitter from "./utils/EventEmitter"
import inject from "./inject"

/**
 * dev tool support
 */
let isDevtoolsEnabled = false

let isUsingStaticRendering = false

let warnedAboutObserverInjectDeprecation = false

// WeakMap<Node, Object>;
export const componentByNodeRegistery = typeof WeakMap !== "undefined" ? new WeakMap() : undefined
export const renderReporter = new EventEmitter()

function findDOMNode(component) {
    if (baseFindDOMNode) {
        try {
            return baseFindDOMNode(component)
        } catch (e) {
            // findDOMNode will throw in react-test-renderer, see:
            // See https://github.com/mobxjs/mobx-react/issues/216
            // Is there a better heuristic?
            return null
        }
    }
    return null
}

// 开发时候的帮助函数
function reportRendering(component) {
    const node = findDOMNode(component)
    if (node && componentByNodeRegistery) componentByNodeRegistery.set(node, component)

    renderReporter.emit({
        event: "render",
        renderTime: component.__$mobRenderEnd - component.__$mobRenderStart,
        totalTime: Date.now() - component.__$mobRenderStart,
        component: component,
        node: node
    })
}

export function trackComponents() {
    if (typeof WeakMap === "undefined")
        throw new Error("[mobx-react] tracking components is not supported in this browser.")
    if (!isDevtoolsEnabled) isDevtoolsEnabled = true
}

export function useStaticRendering(useStaticRendering) {
    isUsingStaticRendering = useStaticRendering
}

/**
 * Errors reporter
 */

export const errorsReporter = new EventEmitter()

/**
 * Utilities
 */

// 绑定函数
function patch(target, funcName, runMixinFirst = false) {
    const base = target[funcName]
    const mixinFunc = reactiveMixin[funcName]
    //  新的componentWillMount mixin 执行的顺序要先于原组件的componentWillMount
    const f = !base
        ? mixinFunc
        : runMixinFirst === true
          ? function() {
                mixinFunc.apply(this, arguments)
                base.apply(this, arguments)
            }
          : function() {
                base.apply(this, arguments)
                mixinFunc.apply(this, arguments)
            }

    // MWE: ideally we freeze here to protect against accidental overwrites in component instances, see #195
    // ...but that breaks react-hot-loader, see #231...
    target[funcName] = f
}

// 浅比较 基于PureComponent的shouldComponentUpdate的实现
function shallowEqual(objA, objB) {
    //From: https://github.com/facebook/fbjs/blob/c69904a511b900266935168223063dd8772dfc40/packages/fbjs/src/core/shallowEqual.js
    //比较两个对象是否相等
    if (is(objA, objB)) return true
    if (typeof objA !== "object" || objA === null || typeof objB !== "object" || objB === null) {
        return false
    }
    const keysA = Object.keys(objA)
    const keysB = Object.keys(objB)
    if (keysA.length !== keysB.length) return false
    for (let i = 0; i < keysA.length; i++) {
        if (!hasOwnProperty.call(objB, keysA[i]) || !is(objA[keysA[i]], objB[keysA[i]])) {
            return false
        }
    }
    return true
}

function is(x, y) {
    // From: https://github.com/facebook/fbjs/blob/c69904a511b900266935168223063dd8772dfc40/packages/fbjs/src/core/shallowEqual.js
    if (x === y) {
        return x !== 0 || 1 / x === 1 / y
    } else {
        return x !== x && y !== y
    }
}

/**
 * ReactiveMixin
 */
const reactiveMixin = {
    componentWillMount: function() {
        if (isUsingStaticRendering === true) return
        // Generate friendly name for debugging
        const initialName =
            this.displayName ||
            this.name ||
            (this.constructor && (this.constructor.displayName || this.constructor.name)) ||
            "<component>"
        const rootNodeID =
            (this._reactInternalInstance && this._reactInternalInstance._rootNodeID) ||
            (this._reactInternalFiber && this._reactInternalFiber._debugID)

        /**
         * If props are shallowly modified, react will render anyway,
         * so atom.reportChanged() should not result in yet another re-render
         *
        /* 
        如果props浅比较发现已经发生改变，那么组件一定会更新，所以这个时候就不应该调用atom.reportChanged()
        避免造成重复渲染
        */

        let skipRender = false
        /**
         * forceUpdate will re-assign this.props. We don't want that to cause a loop,
         * so detect these changes
         */

        // 在foreUpdate中会重复引用this.props 避免造成死循环
        let isForcingUpdate = false

        // 包裹属性成obserable
        function makePropertyObservableReference(propName) {
            let valueHolder = this[propName]
            const atom = new Atom("reactive " + propName)
            Object.defineProperty(this, propName, {
                configurable: true,
                enumerable: true,
                get: function() {
                    atom.reportObserved()
                    return valueHolder
                },
                set: function set(v) {
                    if (!isForcingUpdate && !shallowEqual(valueHolder, v)) {
                        valueHolder = v
                        skipRender = true
                        atom.reportChanged() //=> 触发对应的reaction 例如compute时候访问的时候拿到的是最新的值
                        skipRender = false
                    } else {
                        //属性没有发生变化
                        valueHolder = v
                    }
                }
            })
        }

        // make this.props an observable reference, see #124
        makePropertyObservableReference.call(this, "props")
        // make state an observable reference
        makePropertyObservableReference.call(this, "state")

        // wire up reactive render
        const baseRender = this.render.bind(this)
        let reaction = null
        let isRenderingPending = false

        const initialRender = () => {
            // reaction.track跟踪到obserable改变=>这个reaction的执行
            reaction = new Reaction(`${initialName}#${rootNodeID}.render()`, () => {
                if (!isRenderingPending) {
                    // N.B. Getting here *before mounting* means that a component constructor has side effects (see the relevant test in misc.js)
                    // This unidiomatic React usage but React will correctly warn about this so we continue as usual
                    // See #85 / Pull #44
                    isRenderingPending = true
                    if (typeof this.componentWillReact === "function") this.componentWillReact() // TODO: wrap in action?
                    if (this.__$mobxIsUnmounted !== true) {
                        // If we are unmounted at this point, componentWillReact() had a side effect causing the component to unmounted
                        // TODO: remove this check? Then react will properly warn about the fact that this should not happen? See #73
                        // However, people also claim this migth happen during unit tests..
                        let hasError = true
                        try {
                            isForcingUpdate = true
                            if (!skipRender) Component.prototype.forceUpdate.call(this)
                            hasError = false
                        } finally {
                            isForcingUpdate = false
                            if (hasError) reaction.dispose()
                        }
                    }
                }
            })
            reaction.reactComponent = this
            reactiveRender.$mobx = reaction
            // 重写render
            this.render = reactiveRender
            // 第一次的时候直接执行了这个render render中引用的obserable就和这个reaction关联起来了,引用的obserable发生改变就触发reaction
            return reactiveRender()
        }

        const reactiveRender = () => {
            isRenderingPending = false
            let exception = undefined
            let rendering = undefined
            /**
            * 核心关联部分
            *      
            * 追踪  
            * https://github.com/mobxjs/mobx/blob/master/src/core/reaction.ts#L112
            * 
            * core 
            * ...
            * reaction.track(fn: () => void)
            * const result = trackDerivedFunction(this, fn, undefined)
            *  =>trackDerivedFunction<T>(derivation: IDerivation, f: () => T, context)
            * (https://github.com/mobxjs/mobx/blob/master/src/core/derivation.ts#L131)
            * trackDerivedFunction这个函数有什么作用？ 
            * 执行函数f并跟踪那些可观察并且正在f函数中引用的变量，将这些可追踪的变量注册并储存在derivation中即reaction中
            * 
            * f中引用的变量 核心上是通过atom.reportObserved()关联引用
            * 简单例子见   makePropertyObservableReference  中的      
            *       get: function() {
            *        atom.reportObserved() 
            *        return valueHolder
            *    },
            * obserable
            *   
            *  //f本身已经是箭头函数了,上下文已经绑定过了.
            *  回到上面result = f.call(context); 
            */
            
        //    //reportOberved() => https://github.com/mobxjs/mobx/blob/master/src/core/observable.ts#L143
        //    export function reportObserved(observable: IObservable) {
        //     const derivation = globalState.trackingDerivation  // mobx的全局状态
        //                      // trackingDerivation 储存着observable,而observable中储存着对应的reaction() 形成双向绑定
        //     if (derivation !== null) {
        //         /**
        //          * Simple optimization, give each derivation run an unique id (runId)
        //          * Check if last time this observable was accessed the same runId is used
        //          * if this is the case, the relation is already known
        //          */
        //         if (derivation.runId !== observable.lastAccessedBy) {
        //             // 更新最后一次访问的id
        //             observable.lastAccessedBy = derivation.runId
        //             // ts 断言 newObserving不为空,将obserable 先存在newObserving中 
        //             derivation.newObserving![derivation.unboundDepsCount++] = observable
        //         }
        //     } else if (observable.observers.length === 0) {
        //         queueForUnobservation(observable)
        //     }
        // }
        
        
            reaction.track(() => {
                if (isDevtoolsEnabled) {
                    this.__$mobRenderStart = Date.now()
                }
                try {

                   
              rendering = extras.allowStateChanges(false, baseRender)
            //   export function allowStateChanges<T>(allowStateChanges: boolean, func: () => T): T {
            //     // TODO: deprecate / refactor this function in next major
            //     // Currently only used by `@observer`
            //     // Proposed change: remove first param, rename to `forbidStateChanges`,
            //     // require error callback instead of the hardcoded error message now used
            //     // Use `inAction` instead of allowStateChanges in derivation.ts to check strictMode
            //     const prev = allowStateChangesStart(allowStateChanges) //保存之前状态
            //     let res
            //     try {
            //         res = func()             //执行下一次render
            //     } finally {
            //         allowStateChangesEnd(prev)   //回滚
            //     } 
            //     return res
            // }
                } catch (e) {
                    exception = e
                }
                if (isDevtoolsEnabled) {
                    this.__$mobRenderEnd = Date.now()
                }
            })
            
            if (exception) {
                errorsReporter.emit(exception)
                throw exception
            }
            return rendering
        }
        // 重写第一次执行的render的时候执行initialRender
        this.render = initialRender
    },

    componentWillUnmount: function() {
        if (isUsingStaticRendering === true) return
        //取消订阅
        this.render.$mobx && this.render.$mobx.dispose()
        this.__$mobxIsUnmounted = true
        if (isDevtoolsEnabled) {
            const node = findDOMNode(this)
            if (node && componentByNodeRegistery) {
                componentByNodeRegistery.delete(node)
            }
            renderReporter.emit({
                event: "destroy",
                component: this,
                node: node
            })
        }
    },

    componentDidMount: function() {
        if (isDevtoolsEnabled) {
            reportRendering(this)
        }
    },

    componentDidUpdate: function() {
        if (isDevtoolsEnabled) {
            reportRendering(this)
        }
    },

    // PureComponent
    shouldComponentUpdate: function(nextProps, nextState) {
        if (isUsingStaticRendering) {
            console.warn(
                "[mobx-react] It seems that a re-rendering of a React component is triggered while in static (server-side) mode. Please make sure components are rendered only once server-side."
            )
        }
        // update on any state changes (as is the default)
        if (this.state !== nextState) {
            return true
        }
        // update if props are shallowly not equal, inspired by PureRenderMixin
        // we could return just 'false' here, and avoid the `skipRender` checks etc
        // however, it is nicer if lifecycle events are triggered like usually,
        // so we return true here if props are shallowly modified.
        return !shallowEqual(this.props, nextProps)
    }
}

/**
 * Observer function / decorator
 */
export function observer(arg1, arg2) {
    if (typeof arg1 === "string") {
        throw new Error("Store names should be provided as array")
    }
    if (Array.isArray(arg1)) {
        // component needs stores
        if (!warnedAboutObserverInjectDeprecation) {
            warnedAboutObserverInjectDeprecation = true
            console.warn(
                'Mobx observer: Using observer to inject stores is deprecated since 4.0. Use `@inject("store1", "store2") @observer ComponentClass` or `inject("store1", "store2")(observer(componentClass))` instead of `@observer(["store1", "store2"]) ComponentClass`'
            )
        }
        if (!arg2) {
            // invoked as decorator
            return componentClass => observer(arg1, componentClass)
        } else {
            return inject.apply(null, arg1)(observer(arg2))
        }
    }
    const componentClass = arg1

    if (componentClass.isMobxInjector === true) {
        console.warn(
            "Mobx observer: You are trying to use 'observer' on a component that already has 'inject'. Please apply 'observer' before applying 'inject'"
        )
    }

    // 对于无状态组件重新构建成 class Component
    // Stateless function component:
    // If it is function but doesn't seem to be a react class constructor,
    // wrap it to a react class automatically
    if (
        typeof componentClass === "function" &&
        (!componentClass.prototype || !componentClass.prototype.render) &&
        !componentClass.isReactClass &&
        !Component.isPrototypeOf(componentClass)
    ) {
        return observer(
            class extends Component {
                static displayName = componentClass.displayName || componentClass.name
                static contextTypes = componentClass.contextTypes
                static propTypes = componentClass.propTypes
                static defaultProps = componentClass.defaultProps
                render() {
                    return componentClass.call(this, this.props, this.context)
                }
            }
        )
    }

    if (!componentClass) {
        throw new Error("Please pass a valid component to 'observer'")
    }

    const target = componentClass.prototype || componentClass
    mixinLifecycleEvents(target)
    componentClass.isMobXReactObserver = true
    return componentClass
}

function mixinLifecycleEvents(target) {
    patch(target, "componentWillMount", true)
    ;["componentDidMount", "componentWillUnmount", "componentDidUpdate"].forEach(function(
        funcName
    ) {
        patch(target, funcName)
    })
    if (!target.shouldComponentUpdate) {
        target.shouldComponentUpdate = reactiveMixin.shouldComponentUpdate
    }
}

// TODO: support injection somehow as well?
export const Observer = observer(({ children, inject: observerInject, render }) => {
    const component = children || render
    if (typeof component === "undefined") {
        return null
    }
    if (!observerInject) {
        return component()
    }
    const InjectComponent = inject(observerInject)(component)
    return <InjectComponent />
})

Observer.displayName = "Observer"

const ObserverPropsCheck = (props, key, componentName, location, propFullName) => {
    const extraKey = key === "children" ? "render" : "children"
    if (typeof props[key] === "function" && typeof props[extraKey] === "function") {
        return new Error(
            "Invalid prop,do not use children and render in the same time in`" + componentName
        )
    }

    if (typeof props[key] === "function" || typeof props[extraKey] === "function") {
        return
    }
    return new Error(
        "Invalid prop `" +
            propFullName +
            "` of type `" +
            typeof props[key] +
            "` supplied to" +
            " `" +
            componentName +
            "`, expected `function`."
    )
}

Observer.propTypes = {
    render: ObserverPropsCheck,
    children: ObserverPropsCheck
}
