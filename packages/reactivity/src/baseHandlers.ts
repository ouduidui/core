import {
  reactive,
  readonly,
  toRaw,
  ReactiveFlags,
  Target,
  readonlyMap,
  reactiveMap,
  shallowReactiveMap,
  shallowReadonlyMap,
  isReadonly
} from './reactive'
import { TrackOpTypes, TriggerOpTypes } from './operations'
import {
  track,
  trigger,
  ITERATE_KEY,
  pauseTracking,
  resetTracking
} from './effect'
import {
  isObject,
  hasOwn,
  isSymbol,
  hasChanged,
  isArray,
  isIntegerKey,
  extend,
  makeMap
} from '@vue/shared'
import { isRef } from './ref'

const isNonTrackableKeys = /*#__PURE__*/ makeMap(`__proto__,__v_isRef,__isVue`)

const builtInSymbols = new Set(
  Object.getOwnPropertyNames(Symbol)
    .map(key => (Symbol as any)[key])
    .filter(isSymbol)
)

const get = /*#__PURE__*/ createGetter()
const shallowGet = /*#__PURE__*/ createGetter(false, true)
const readonlyGet = /*#__PURE__*/ createGetter(true)
const shallowReadonlyGet = /*#__PURE__*/ createGetter(true, true)

const arrayInstrumentations = /*#__PURE__*/ createArrayInstrumentations()

// 处理数组的原型方法
function createArrayInstrumentations() {
  const instrumentations: Record<string, Function> = {}
  // instrument identity-sensitive Array methods to account for possible reactive
  // values
  ;(['includes', 'indexOf', 'lastIndexOf'] as const).forEach(key => {
    instrumentations[key] = function (this: unknown[], ...args: unknown[]) {
      const arr = toRaw(this) as any
      for (let i = 0, l = this.length; i < l; i++) {
        // 收集依赖
        track(arr, TrackOpTypes.GET, i + '')
      }
      // we run the method using the original args first (which may be reactive)
      const res = arr[key](...args)
      if (res === -1 || res === false) {
        // if that didn't work, run it again using raw values.
        return arr[key](...args.map(toRaw))
      } else {
        return res
      }
    }
  })
  // instrument length-altering mutation methods to avoid length being tracked
  // which leads to infinite loops in some cases (#2137)
  // 因为执行以下方法时，会改变数组元素，因此会触发到set操作，如果插入的是对象的话，在setter会触发依赖搜集，因此在这里无需再次依赖搜集
  ;(['push', 'pop', 'shift', 'unshift', 'splice'] as const).forEach(key => {
    instrumentations[key] = function (this: unknown[], ...args: unknown[]) {
      // 不需要收集依赖
      pauseTracking()
      const res = (toRaw(this) as any)[key].apply(this, args)
      resetTracking()
      return res
    }
  })
  return instrumentations
}

// 创建Proxy的get处理函数
function createGetter(isReadonly = false, shallow = false) {
  return function get(target: Target, key: string | symbol, receiver: object) {
    if (key === ReactiveFlags.IS_REACTIVE) {
      return !isReadonly // 用于isReactive函数
    } else if (key === ReactiveFlags.IS_READONLY) {
      return isReadonly  // 用于isReadonly函数
    } else if (
      key === ReactiveFlags.RAW &&
      receiver ===
        (isReadonly
          ? shallow
            ? shallowReadonlyMap
            : readonlyMap
          : shallow
          ? shallowReactiveMap
          : reactiveMap
        ).get(target)
    ) {
      return target  // 用于toRaw函数
    }

    const targetIsArray = isArray(target)

    // 调用数组原生方法
    if (!isReadonly && targetIsArray && hasOwn(arrayInstrumentations, key)) {
      return Reflect.get(arrayInstrumentations, key, receiver)
    }

    // 获取get访问的值，最终将res返回出去
    const res = Reflect.get(target, key, receiver)

    // 如果是内置符号属性或者vue特有属性，无需触发依赖搜集
    if (isSymbol(key) ? builtInSymbols.has(key) : isNonTrackableKeys(key)) {
      return res
    }

    // 如果是readonly只读的话，是不可以被set的，因此也就不可能触发到trigger
    // 因此当时readonly的时候，就没有收集依赖的必要了
    if (!isReadonly) {
      // 在触发get的时候进行依赖收集
      track(target, TrackOpTypes.GET, key)
    }

    if (shallow) {
      return res
    }

    // 如果结果是ref对象，返回.value
    if (isRef(res)) {
      // ref unwrapping - does not apply for Array + integer key.
      const shouldUnwrap = !targetIsArray || !isIntegerKey(key)
      return shouldUnwrap ? res.value : res
    }

    // 如果res是对象的话，那么我们需要把获取的res也转化成reactive，也就是将其都用reactive包裹，变成响应式对象
    if (isObject(res)) {
      // Convert returned value into a proxy as well. we do the isObject check
      // here to avoid invalid value warning. Also need to lazy access readonly
      // and reactive here to avoid circular dependency.
      return isReadonly ? readonly(res) : reactive(res)
    }

    // 最后将res值返回出去
    return res
  }
}

const set = /*#__PURE__*/ createSetter()
const shallowSet = /*#__PURE__*/ createSetter(true)

/**
 * 创建Proxy的set处理函数
 * @param shallow
 */
function createSetter(shallow = false) {
  return function set(
    target: object,
    key: string | symbol,
    value: unknown,
    receiver: object
  ): boolean {
    let oldValue = (target as any)[key]
    if (!shallow && !isReadonly(value)) {
      // 将value和oldValue获取原始值
      value = toRaw(value)
      oldValue = toRaw(oldValue)
      if (!isArray(target) && isRef(oldValue) && !isRef(value)) {
        oldValue.value = value
        return true
      }
    } else {
      // in shallow mode, objects are set as-is regardless of reactive or not
    }

    // 判断是否之前是否有此值
    const hadKey =
      isArray(target) && isIntegerKey(key)
        ? Number(key) < target.length
        : hasOwn(target, key)

    // 使用Reflect.set设置新值，并获取result最后返回出去
    const result = Reflect.set(target, key, value, receiver)
    // don't trigger if target is something up in the prototype chain of original
    if (target === toRaw(receiver)) {
      // 执行trigger触发依赖
      if (!hadKey) {
        trigger(target, TriggerOpTypes.ADD, key, value)
      } else if (hasChanged(value, oldValue)) {
        trigger(target, TriggerOpTypes.SET, key, value, oldValue)
      }
    }

    // 将result返回
    return result
  }
}

/**
 * proxy的deleteProperty处理函数
 * @param target
 * @param key
 */
function deleteProperty(target: object, key: string | symbol): boolean {
  const hadKey = hasOwn(target, key)
  const oldValue = (target as any)[key]
  // 执行删除操作
  const result = Reflect.deleteProperty(target, key)
  if (result && hadKey) {
    // 触发依赖
    trigger(target, TriggerOpTypes.DELETE, key, undefined, oldValue)
  }
  return result
}

/**
 * proxy的has操作处理器
 * @param target
 * @param key
 */
function has(target: object, key: string | symbol): boolean {
  // 执行has操作
  const result = Reflect.has(target, key)
  if (!isSymbol(key) || !builtInSymbols.has(key)) {
    // 收集依赖
    track(target, TrackOpTypes.HAS, key)
  }
  return result
}

/**
 * proxy的ownKeys操作处理器
 * @param target
 */
function ownKeys(target: object): (string | symbol)[] {
  // 收集依赖
  track(target, TrackOpTypes.ITERATE, isArray(target) ? 'length' : ITERATE_KEY)
  return Reflect.ownKeys(target)
}

// 可变的proxy处理器对象
export const mutableHandlers: ProxyHandler<object> = {
  get,  // 拦截获取操作
  set,  // 拦截设置操作
  deleteProperty,   // 拦截删除操作
  has,   // 拦截in操作
  ownKeys  // 拦截 Reflect.ownKeys()
}

export const readonlyHandlers: ProxyHandler<object> = {
  get: readonlyGet,
  set(target, key) {
    if (__DEV__) {
      console.warn(
        `Set operation on key "${String(key)}" failed: target is readonly.`,
        target
      )
    }
    return true
  },
  deleteProperty(target, key) {
    if (__DEV__) {
      console.warn(
        `Delete operation on key "${String(key)}" failed: target is readonly.`,
        target
      )
    }
    return true
  }
}

export const shallowReactiveHandlers = /*#__PURE__*/ extend(
  {},
  mutableHandlers,
  {
    get: shallowGet,
    set: shallowSet
  }
)

// Props handlers are special in the sense that it should not unwrap top-level
// refs (in order to allow refs to be explicitly passed down), but should
// retain the reactivity of the normal readonly object.
export const shallowReadonlyHandlers = /*#__PURE__*/ extend(
  {},
  readonlyHandlers,
  {
    get: shallowReadonlyGet
  }
)
