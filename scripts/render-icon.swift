// Reproduce the app's existing vector A mark as an opaque 1024px iOS asset.
import AppKit
import CoreGraphics
import Foundation

let dimension = 1024
let colorSpace = CGColorSpaceCreateDeviceRGB()
let context = CGContext(data: nil, width: dimension, height: dimension,
                        bitsPerComponent: 8, bytesPerRow: dimension * 4,
                        space: colorSpace, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
context.setFillColor(CGColor(red: 0.043, green: 0.051, blue: 0.086, alpha: 1))
context.fill(CGRect(x: 0, y: 0, width: dimension, height: dimension))
context.setLineCap(.round)
context.setLineJoin(.round)
context.setLineWidth(68)
context.move(to: CGPoint(x: 332, y: 300))
context.addLine(to: CGPoint(x: 512, y: 740))
context.addLine(to: CGPoint(x: 692, y: 300))
context.move(to: CGPoint(x: 397, y: 450))
context.addLine(to: CGPoint(x: 627, y: 450))
context.replacePathWithStrokedPath()
context.clip()
let gradient = CGGradient(colorsSpace: colorSpace, colors: [
    CGColor(red: 0.369, green: 0.918, blue: 0.831, alpha: 1),
    CGColor(red: 0.655, green: 0.545, blue: 0.98, alpha: 1)
] as CFArray, locations: [0, 1])!
context.drawLinearGradient(gradient, start: CGPoint(x: 320, y: 720), end: CGPoint(x: 700, y: 300), options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
let bitmap = NSBitmapImageRep(cgImage: context.makeImage()!)
let png = bitmap.representation(using: .png, properties: [:])!
let destination = CommandLine.arguments.dropFirst().first ?? "ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png"
try png.write(to: URL(fileURLWithPath: destination))
print("Ava icon: 1024×1024 opaque PNG")
