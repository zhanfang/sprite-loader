'use strict';
const path = require('path');
const css = require('css');
const Spritesmith = require('spritesmith');
const _ = require('lodash');
const co = require('co');
const loaderUtils = require('loader-utils');
const fs = require('fs');
const jimp = require('jimp');
const BG_URL_REG = /url\((.+\.(png|jpg|jpeg|gif))(.*)\)/i;
const SPRITE_IGNORE = /#spriteignore/i;
const BG_REPEAT_REG = /repeat-(x|y)/;
const PADDING = 20;

const PixelRatio = {
    X1: 1,
    X2: 2
};

const RepeatType = {
    X: 'repeat-x',
    Y: 'repeat-y',
    NONE: 'no-repeat'
};

function grouping(rules) {
    let groups = [];
    rules.forEach(rule => {
        let bgImgDef = getBgImgDef(rule);
        if (bgImgDef && !bgImgDef.url.startsWith('http') && isNeedSprite(rule)) {
            let groupType = {
                ratio: is2x(bgImgDef.url) ? PixelRatio.X2 : PixelRatio.X1,
                repeat: getRepeatType(rule)
            };
            let group = _.find(groups, groupType);
            if (group) {
                group.defs.push(bgImgDef);
            } else {
                groups.push(Object.assign({defs: [bgImgDef]}, groupType));
            }
        }
    });
    return groups.filter(g => g.defs.length);
}

function getBgImgDef(rule) {
    let arr = rule.declarations && rule.declarations.slice(0);
    while (arr && arr.length) {
        let d = arr.pop();
        if (d.property == 'background' || d.property == 'background-image') {
            let match = BG_URL_REG.exec(d.value);
            if (match && !SPRITE_IGNORE.test(match[3])) {
                return {
                    url: match[1].replace(/['"]/g, '').trim(),
                    declaration: d,
                    rule: rule
                };
            }
        }
    }
}

function isNeedSprite(rule) {
    return !_.find(rule.declarations, d => {
        return d.property == 'background-position';
    })
}

function is2x(url) {
    return url && url.endsWith('2x.png');
}

function getRepeatType(rule) {
    let arr = rule.declarations.slice(0);
    while (arr.length) {
        let d = arr.pop();
        if (d.property == 'background' || d.property == 'background-repeat') {
            let match = BG_REPEAT_REG.exec(d.value);
            if (match) return 'repeat-' + match[1];
        }
    }
    return RepeatType.NONE;
}

function createSpriteImage(images, repeatType) {
    let algMap = {'repeat-x': 'top-down', 'repeat-y': 'left-right'};
    return new Promise(function (resolve, reject) {
        Spritesmith.run({
            src: images,
            algorithm: algMap[repeatType] || 'binary-tree',
            padding: PADDING
        }, function (err, result) {
            if (err) {
                reject(err);
            } else {
                resolve(result);
            }
        });
    });
}

async function emitSprite(name, buffer) {
    let options = (loaderUtils.getOptions ? loaderUtils.getOptions(this) : loaderUtils.parseQuery(this.query)) || {};
    let outputPath = options.outputPath || '';

    let cssImagePath = options.cssImagePath || this._compiler.options.output.publicPath;
    let nameTpl = 'spirte.[hash:7].png';

    let url = loaderUtils.interpolateName(this, nameTpl, {
        content: buffer
    });

    await this.emitFile(outputPath + url, buffer);

    return cssImagePath + url;
}

function toPr(num) {
    return !num ? 0 : num + 'pr';
}

function toPx(num) {
    return !num ? 0 : num + 'px';
}

function safeCut(num) {
    return num;
}

function isNeedProcess(rules) {
    let confComment = _.find(rules, r => r.type == 'comment' && r.comment.indexOf('sprite-loader') > -1);
    if (confComment) {
        let value = confComment.comment.trim();
        return value == 'sprite-loader-enable';
    } else {
        return false;
    }
}

module.exports.getBgImgDef = getBgImgDef;
module.exports.getRepeatType = getRepeatType;
module.exports.grouping = grouping;
module.exports.createSpriteImage = createSpriteImage;

module.exports.loader = function (content) {
    this.cacheable();
    let loader = this;
    let callback = this.async();
    let query = (loaderUtils.getOptions ? loaderUtils.getOptions(this) : loaderUtils.parseQuery(this.query)) || {};
    let ast = css.parse(content);
    const temp = css.stringify(ast);
    if (!isNeedProcess(ast.stylesheet.rules, query)) {
        callback(null, content);
        return;
    }
    let groups = grouping(ast.stylesheet.rules);
    let context = this.context;
    if (query.debug && groups.length) {
        console.log('sprite-loader:', this.resourcePath);
    }
    co(function* () {
        let extraRule = [];
        while (groups.length) {
            let group = groups.pop();
            // 创建图片精灵
            let meta = yield createSpriteImage(group.defs.map(x => path.resolve(context, x.url)), group.repeat);
            let coordinates = meta.coordinates;
            // 实例化，并返回 url
            let file = yield emitSprite.call(loader, query.name, meta.image);

            let groupSelectors = [];
            group.defs.forEach(def => {
                let coordinate = coordinates[path.resolve(context, def.url)];
                if (coordinate) {
                    Array.prototype.push.apply(groupSelectors, def.rule.selectors);

                    def.rule.declarations.push({
                        type: 'declaration',
                        property: 'background-size',
                        value: `${toPr(meta.properties.width)} ${toPr(meta.properties.height)}`
                    });

                    def.declaration.property = 'background-position';
                    def.declaration.value = `${toPr(-coordinate.x)} ${toPr(-coordinate.y)}`;
                }

            });

            extraRule.push({
                type: 'rule',
                selectors: groupSelectors,
                declarations: [{
                    type: 'declaration',
                    property: 'background',
                    value: `url(${file}) no-repeat -9999px -9999px`
                }]
            });
        }
        ast.stylesheet.rules = extraRule.concat(ast.stylesheet.rules);
        return css.stringify(ast);
    })
        .then(cssText => callback(null, cssText))
        .catch(e => callback(e));
};