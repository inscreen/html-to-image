import type { Options } from './types'
import { clonePseudoElements } from './clone-pseudos'
import { toArray, isInstanceOfElement } from './util'

function cloneCanvasElement(canvas: HTMLCanvasElement) {
  try {
    const dataURL = canvas.toDataURL()
    if (dataURL === 'data:,') {
      return canvas.cloneNode(false) as HTMLCanvasElement
    }
    const img = document.createElement('img')
    img.src = dataURL
    return img
  } catch (e) {
    console.error('Unable to inline canvas contents, canvas is tainted', canvas)
    return null
  }
}

function cloneVideoElement(video: HTMLVideoElement) {
  try {
    let imgSrc
    if (video.currentSrc) {
      const canvas = document.createElement('canvas')
      const ctx = canvas.getContext('2d')
      canvas.width = video.clientWidth
      canvas.height = video.clientHeight
      ctx?.drawImage(video, 0, 0, canvas.width, canvas.height)
      imgSrc = canvas.toDataURL()
    }
    const img = document.createElement('img')
    img.src = imgSrc ?? video.poster
    return img
  } catch (e) {
    console.error('Unable to clone video as it is tainted', video)
    return null
  }
}

async function cloneIFrameElement(iframe: HTMLIFrameElement) {
  try {
    if (iframe?.contentDocument?.body) {
      return (await cloneNode(
        iframe.contentDocument.body,
        {},
      )) as HTMLBodyElement
    }
  } catch {
    // Failed to clone iframe
  }

  return iframe.cloneNode(false) as HTMLIFrameElement
}

// TODO: make function synchronous
async function cloneSingleNode<T extends HTMLElement>(
  node: T,
): Promise<HTMLElement | null> {
  if (isInstanceOfElement(node, HTMLCanvasElement)) {
    return cloneCanvasElement(node)
  }

  if (isInstanceOfElement(node, HTMLVideoElement)) {
    return cloneVideoElement(node)
  }

  if (isInstanceOfElement(node, HTMLIFrameElement)) {
    return cloneIFrameElement(node)
  }

  return node.cloneNode(false) as T
}

const isSlotElement = (node: HTMLElement): node is HTMLSlotElement =>
  node.tagName != null && node.tagName.toUpperCase() === 'SLOT'

async function cloneChildren<T extends HTMLElement>(
  nativeNode: T,
  clonedNode: T,
  options: Options,
): Promise<T> {
  let children: T[] = []

  if (isSlotElement(nativeNode) && nativeNode.assignedNodes) {
    children = toArray<T>(nativeNode.assignedNodes())
  } else if (
    isInstanceOfElement(nativeNode, HTMLIFrameElement) &&
    nativeNode.contentDocument?.body
  ) {
    children = toArray<T>(nativeNode.contentDocument.body.childNodes)
  } else {
    children = toArray<T>((nativeNode.shadowRoot ?? nativeNode).childNodes)
  }

  if (
    children.length === 0 ||
    isInstanceOfElement(nativeNode, HTMLVideoElement)
  ) {
    return clonedNode
  }

  await children.reduce(
    (deferred, child) =>
      deferred
        .then(() => cloneNode(child, options))
        .then((clonedChild: HTMLElement | null) => {
          if (clonedChild) {
            clonedNode.appendChild(clonedChild)
          }
        }),
    Promise.resolve(),
  )

  return clonedNode
}

function cloneCSSStyle<T extends HTMLElement>(
  nativeNode: T,
  clonedNode: T,
  sourceStyle: CSSStyleDeclaration,
) {
  const targetStyle = clonedNode.style
  if (!targetStyle) {
    return
  }

  if (sourceStyle.cssText) {
    targetStyle.cssText = sourceStyle.cssText
    targetStyle.transformOrigin = sourceStyle.transformOrigin
  } else {
    toArray<string>(sourceStyle).forEach((name) => {
      let value = sourceStyle.getPropertyValue(name)
      if (name === 'font-size' && value.endsWith('px')) {
        const reducedFont =
          Math.floor(parseFloat(value.substring(0, value.length - 2))) - 0.1
        value = `${reducedFont}px`
      }

      if (
        isInstanceOfElement(nativeNode, HTMLIFrameElement) &&
        name === 'display' &&
        value === 'inline'
      ) {
        value = 'block'
      }

      if (name === 'd' && clonedNode.getAttribute('d')) {
        value = `path(${clonedNode.getAttribute('d')})`
      }

      targetStyle.setProperty(
        name,
        value,
        sourceStyle.getPropertyPriority(name),
      )
    })
  }
}

function cloneInputValue<T extends HTMLElement>(nativeNode: T, clonedNode: T) {
  if (isInstanceOfElement(nativeNode, HTMLTextAreaElement)) {
    clonedNode.innerHTML = nativeNode.value
  }

  if (isInstanceOfElement(nativeNode, HTMLInputElement)) {
    clonedNode.setAttribute('value', nativeNode.value)
  }
}

function cloneSelectValue<T extends HTMLElement>(nativeNode: T, clonedNode: T) {
  if (isInstanceOfElement(nativeNode, HTMLSelectElement)) {
    const clonedSelect = clonedNode as any as HTMLSelectElement
    const selectedOption = Array.from(clonedSelect.children).find(
      (child) => nativeNode.value === child.getAttribute('value'),
    )

    if (selectedOption) {
      selectedOption.setAttribute('selected', '')
    }
  }
}

function cloneScrollPosition<T extends HTMLElement>(
  nativeNode: T,
  clonedNode: T,
) {
  // If element is not scrolled, we don't need to move the children.
  if (nativeNode.scrollTop === 0 && nativeNode.scrollLeft === 0) {
    return
  }

  for (let i = 0; i < clonedNode.children.length; i++) {
    const child = clonedNode.children[i] as HTMLElement
    if (!('style' in child)) {
      return
    }

    // For each of the children, get the current transform and translate it with the native node's scroll position.
    child.style.transform = new DOMMatrix(child.style.transform)
      .translateSelf(-nativeNode.scrollLeft, -nativeNode.scrollTop)
      .toString()
  }
}

/**
 * TODO: re-add and optimise ensureSVGSymbols, run it as a "filter" - once per <use> tag
 * https://github.com/bubkoo/html-to-image/issues/341
 * on the original commit - it runs `clone.querySelectorAll('use')` on each node and `document.querySelector(id)` for each tag found
 */

const isTextNode = (node: Node): node is Text => node.nodeType === 3 // Node.TEXT_NODE
const isElementNode = (node: Node): node is HTMLElement => node.nodeType === 1 // Node.ELEMENT_NODE

export async function cloneNode<T extends Node>(
  node: T,
  options: Options,
): Promise<Node | null> {
  if (isTextNode(node)) {
    return document.createTextNode(node.data)
  }

  if (!isElementNode(node)) {
    return node.cloneNode(false) as HTMLElement
  }

  if (options.filter && !options.filter(node)) {
    return null
  }

  const style = window.getComputedStyle(node)

  if (style.getPropertyValue('display') === 'none') {
    return null
  }

  const clonedNode = await cloneSingleNode(node)

  if (!clonedNode) {
    return null
  }

  cloneCSSStyle(node, clonedNode, style)

  clonePseudoElements(node, clonedNode)

  cloneInputValue(node, clonedNode)

  cloneSelectValue(node, clonedNode)

  await cloneChildren(node, clonedNode, options)

  cloneScrollPosition(node, clonedNode)

  return clonedNode
}
