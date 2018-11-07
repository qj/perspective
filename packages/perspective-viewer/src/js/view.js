/******************************************************************************
 *
 * Copyright (c) 2017, the Perspective Authors.
 *
 * This file is part of the Perspective library, distributed under the terms of
 * the Apache License 2.0.  The full license can be found in the LICENSE file.
 *
 */

import "@webcomponents/webcomponentsjs";
import "@webcomponents/shadycss/custom-style-interface.min.js";

import _ from "underscore";
import {polyfill} from "mobile-drag-drop";

import perspective from "@jpmorganchase/perspective/src/js/perspective.parallel.js";
import {ViewPrivate} from "./view/ViewPrivate.js";
import "./row.js";

import {bindTemplate, json_attribute, array_attribute, copy_to_clipboard} from "./utils.js";
import {renderers} from "./view/renderers.js";
import {COMPUTATIONS} from "./computed_column.js";

import template from "../html/view.html";

import view_style from "../less/view.less";
import default_style from "../less/default.less";

polyfill({});

/******************************************************************************
 *
 * Plugin API
 *
 */

global.registerPlugin = renderers.registerPlugin;

function _register_debug_plugin() {
    global.registerPlugin("debug", {
        name: "Debug",
        create: async function(div) {
            const csv = await this._view.to_csv({config: {delimiter: "|"}});
            const timer = this._render_time();
            div.innerHTML = `<pre style="margin:0;overflow:scroll;position:absolute;width:100%;height:100%">${csv}</pre>`;
            timer();
        },
        selectMode: "toggle",
        resize: function() {},
        delete: function() {}
    });
}

/******************************************************************************
 *
 * Perspective Loading
 *
 */

let worker = (function() {
    let __WORKER__;
    return {
        getInstance: function() {
            if (__WORKER__ === undefined) {
                __WORKER__ = perspective.worker();
            }
            return __WORKER__;
        }
    };
})();

if (document.currentScript && document.currentScript.hasAttribute("preload")) {
    worker.getInstance();
}

/**
 * HTMLElement class for `<perspective-viewer` custom element.
 *
 * @class View
 * @extends {ViewPrivate}
 */

// Eslint complains here because we don't do anything, but actually we globally
// register this class as a CustomElement
@bindTemplate(template, {toString: () => view_style.toString() + "\n" + default_style.toString()}) // eslint-disable-next-line no-unused-vars
class View extends ViewPrivate {
    constructor() {
        super();
        this._register_debounce_instance();
        this._slaves = [];
        this._show_config = true;
        const resize_handler = _.debounce(this.notifyResize, 250).bind(this);
        window.addEventListener("load", resize_handler);
        window.addEventListener("resize", resize_handler);
    }

    connectedCallback() {
        if (Object.keys(renderers.getInstance()).length === 0) {
            _register_debug_plugin();
        }

        this.setAttribute("settings", true);

        this._register_ids();
        this._register_callbacks();
        this._register_view_options();
        this._register_data_attribute();
        this._toggle_config();

        for (let attr of ["row-pivots", "column-pivots", "filters", "sort"]) {
            if (!this.hasAttribute(attr)) {
                this.setAttribute(attr, "[]");
            }
        }
    }

    /**
     * Sets this `perspective.table.view`'s `sort` property, an array of column
     * names.
     *
     * @name sort
     * @memberof View.prototype
     * @type {array<string>} Array of arrays tuples of column name and
     * direction, where the possible values are "asc", "desc", "asc abs",
     * "desc abs" and "none".
     * @fires View#perspective-config-update
     * @example <caption>via Javascript DOM</caption>
     * let elem = document.getElementById('my_viewer');
     * elem.setAttribute('sort', JSON.stringify([["x","desc"]));
     * @example <caption>via HTML</caption>
     * <perspective-viewer sort='[["x","desc"]]'></perspective-viewer>
     */
    @array_attribute
    set sort(sort) {
        var inner = this._sort.querySelector("ul");
        inner.innerHTML = "";
        if (sort.length > 0) {
            sort.map(
                function(s) {
                    let dir = "asc";
                    if (Array.isArray(s)) {
                        dir = s[1];
                        s = s[0];
                    }
                    let row = this.new_row(s, false, false, false, dir);
                    inner.appendChild(row);
                }.bind(this)
            );
        }
        this.dispatchEvent(new Event("perspective-config-update"));
        this._debounce_update();
    }

    /**
     * The set of visible columns.
     *
     * @name columns
     * @memberof View.prototype
     * @param {array} columns An array of strings, the names of visible columns.
     * @fires View#perspective-config-update
     * @example <caption>via Javascript DOM</caption>
     * let elem = document.getElementById('my_viewer');
     * elem.setAttribute('columns', JSON.stringify(["x", "y'"]));
     * @example <caption>via HTML</caption>
     * <perspective-viewer columns='["x", "y"]'></perspective-viewer>
     */
    @array_attribute
    set columns(show) {
        this._update_column_view(show, true);
        this.dispatchEvent(new Event("perspective-config-update"));
        this._debounce_update();
    }

    /**
     * The set of visible columns.
     *
     * @name computed-columns
     * @memberof View.prototype
     * @param {array} computed-columns An array of computed column objects
     * @fires View#perspective-config-update
     * @example <caption>via Javascript DOM</caption>
     * let elem = document.getElementById('my_viewer');
     * elem.setAttribute('computed-columns', JSON.stringify([{name: "x+y", func: "add", inputs: ["x", "y"]}]));
     * @example <caption>via HTML</caption>
     * <perspective-viewer computed-columns="[{name:'x+y',func:'add',inputs:['x','y']}]""></perspective-viewer>
     */
    @array_attribute
    set "computed-columns"(computed_columns) {
        this.setAttribute("updating", true);
        this._computed_column._close_computed_column();
        (async () => {
            if (this._table) {
                for (let col of computed_columns) {
                    await this._create_computed_column({
                        detail: {
                            column_name: col.name,
                            input_columns: col.inputs.map(x => ({name: x})),
                            computation: COMPUTATIONS[col.func]
                        }
                    });
                }
                await this._debounce_update();
            }
            this.dispatchEvent(new Event("perspective-config-update"));
        })();
    }

    /**
     * The set of column aggregate configurations.
     *
     * @name aggregates
     * @memberof View.prototype
     * @param {object} aggregates A dictionary whose keys are column names, and
     * values are valid aggregations.  The `aggergates` attribute works as an
     * override;  in lieu of a key for a column supplied by the developers, a
     * default will be selected and reflected to the attribute based on the
     * column's type.  See {@link perspective/src/js/defaults.js}
     * @fires View#perspective-config-update
     * @example <caption>via Javascript DOM</caption>
     * let elem = document.getElementById('my_viewer');
     * elem.setAttribute('aggregates', JSON.stringify({x: "distinct count"}));
     * @example <caption>via HTML</caption>
     * <perspective-viewer aggregates='{"x": "distinct count"}'></perspective-viewer>
     */
    @json_attribute
    set aggregates(show) {
        let lis = this._get_view_dom_columns();
        lis.map(x => {
            let agg = show[x.getAttribute("name")];
            if (agg) {
                x.setAttribute("aggregate", agg);
            }
        });
        this.dispatchEvent(new Event("perspective-config-update"));
        this._debounce_update();
    }

    /**
     * The set of column filter configurations.
     *
     * @name filters
     * @memberof View.prototype
     * @type {array} filters An arry of filter config objects.  A filter
     * config object is an array of three elements:
     *     * The column name.
     *     * The filter operation as a string.  See
     *       {@link perspective/src/js/defaults.js}
     *     * The filter argument, as a string, float or Array<string> as the
     *       filter operation demands.
     * @fires View#perspective-config-update
     * @example <caption>via Javascript DOM</caption>
     * let filters = [
     *     ["x", "<", 3],
     *     ["y", "contains", "abc"]
     * ];
     * let elem = document.getElementById('my_viewer');
     * elem.setAttribute('filters', JSON.stringify(filters));
     * @example <caption>via HTML</caption>
     * <perspective-viewer filters='[["x", "<", 3], ["y", "contains", "abc"]]'></perspective-viewer>
     */
    @array_attribute
    set filters(filters) {
        if (!this._updating_filter) {
            var inner = this._filters.querySelector("ul");
            inner.innerHTML = "";
            if (filters.length > 0) {
                filters.map(pivot => {
                    const fterms = JSON.stringify({
                        operator: pivot[1],
                        operand: pivot[2]
                    });
                    const row = this.new_row(pivot[0], undefined, undefined, fterms);
                    inner.appendChild(row);
                });
            }
        }
        this.dispatchEvent(new Event("perspective-config-update"));
        this._debounce_update();
    }

    /**
     * Sets the currently selected plugin, via its `name` field.
     *
     * @type {string}
     * @fires View#perspective-config-update
     */
    set view(v) {
        this._vis_selector.value = this.getAttribute("view");
        this._set_column_defaults();
        this.dispatchEvent(new Event("perspective-config-update"));
    }

    /**
     * Sets this `perspective.table.view`'s `column_pivots` property.
     *
     * @name column-pivots
     * @memberof View.prototype
     * @type {array<string>} Array of column names
     * @fires View#perspective-config-update
     */
    @array_attribute
    set "column-pivots"(pivots) {
        var inner = this._column_pivots.querySelector("ul");
        inner.innerHTML = "";
        if (pivots.length > 0) {
            pivots.map(
                function(pivot) {
                    let row = this.new_row(pivot);
                    inner.appendChild(row);
                }.bind(this)
            );
        }
        this.dispatchEvent(new Event("perspective-config-update"));
        this._debounce_update();
    }

    /**
     * Sets this `perspective.table.view`'s `row_pivots` property.
     *
     * @name row-pivots
     * @memberof View.prototype
     * @type {array<string>} Array of column names
     * @fires View#perspective-config-update
     */
    @array_attribute
    set "row-pivots"(pivots) {
        var inner = this._row_pivots.querySelector("ul");
        inner.innerHTML = "";
        if (pivots.length > 0) {
            pivots.map(
                function(pivot) {
                    let row = this.new_row(pivot);
                    inner.appendChild(row);
                }.bind(this)
            );
        }
        this.dispatchEvent(new Event("perspective-config-update"));
        this._debounce_update();
    }

    /**
     * When set, hide the data visualization and display the message.  Setting
     * `message` does not clear the internal `perspective.table`, but it does
     * render it hidden until the message is removed.
     *
     * @param {string} msg The message. This can be HTML - it is not sanitized.
     * @example
     * let elem = document.getElementById('my_viewer');
     * elem.setAttribute('message', '<h1>Loading</h1>');
     */
    set message(msg) {
        if (this.getAttribute("message") !== msg) {
            this.setAttribute("message", msg);
            return;
        }
        if (!this._inner_drop_target) return;
        this.shadowRoot.querySelector("#app").classList.remove("hide_message");
        this._inner_drop_target.innerHTML = msg;
        for (let slave of this._slaves) {
            slave.setAttribute("message", msg);
        }
    }

    /**
     * This element's `perspective` worker instance.  This property is not
     * reflected as an HTML attribute, and is readonly;  it can be effectively
     * set however by calling the `load() method with a `perspective.table`
     * instance from the preferred worker.
     *
     * @readonly
     * @example
     * let elem = document.getElementById('my_viewer');
     * let table = elem.worker.table([{x:1, y:2}]);
     * elem.load(table);
     */
    get worker() {
        if (this._table) {
            return this._table._worker;
        }
        return worker.getInstance();
    }

    /**
     * This element's `perspective.table.view` instance.  The instance itself
     * will change after every `View#perspective-config-update` event.
     *
     * @readonly
     */
    get view() {
        return this._view;
    }

    /**
     * Load data.  If `load` or `update` have already been called on this
     * element, its internal `perspective.table` will also be deleted.
     *
     * @param {any} data The data to load.  Works with the same input types
     * supported by `perspective.table`.
     * @returns {Promise<void>} A promise which resolves once the data is
     * loaded and a `perspective.view` has been created.
     * @fires View#perspective-view-update
     * @example <caption>Load JSON</caption>
     * const my_viewer = document.getElementById('#my_viewer');
     * my_viewer.load([
     *     {x: 1, y: 'a'},
     *     {x: 2, y: 'b'}
     * ]);
     * @example <caption>Load CSV</caption>
     * const my_viewer = document.getElementById('#my_viewer');
     * my_viewer.load("x,y\n1,a\n2,b");
     * @example <caption>Load perspective.table</caption>
     * const my_viewer = document.getElementById('#my_viewer');
     * const tbl = perspective.table("x,y\n1,a\n2,b");
     * my_viewer.load(tbl);
     */
    load(data, options) {
        try {
            data = data.trim();
        } catch (e) {}
        let table;
        if (data.hasOwnProperty("_name")) {
            table = data;
        } else {
            table = worker.getInstance().table(data, options);
            table._owner_viewer = this;
        }
        let _promises = [this.load_table(table)];
        for (let slave of this._slaves) {
            _promises.push(this.load_table.call(slave, table));
        }
        this._slaves = [];
        return Promise.all(_promises);
    }

    /**
     * Updates this element's `perspective.table` with new data.
     *
     * @param {any} data The data to load.  Works with the same input types
     * supported by `perspective.table.update`.
     * @fires View#perspective-view-update
     * @example
     * const my_viewer = document.getElementById('#my_viewer');
     * my_viewer.update([
     *     {x: 1, y: 'a'},
     *     {x: 2, y: 'b'}
     * ]);
     */
    update(data) {
        if (this._table === undefined) {
            this.load(data);
        } else {
            this._table.update(data);
        }
    }

    /**
     * Determine whether to reflow the viewer and redraw.
     *
     */
    notifyResize() {
        if (this.clientHeight < 500) {
            this.shadowRoot.querySelector("#app").classList.add("columns_horizontal");
        } else {
            this.shadowRoot.querySelector("#app").classList.remove("columns_horizontal");
        }

        if (!document.hidden && this.offsetParent && document.contains(this)) {
            this._plugin.resize.call(this);
        }
    }

    /**
     * Duplicate an existing `<perspective-element>`, including data and view
     * settings.  The underlying `perspective.table` will be shared between both
     * elements
     *
     * @param {any} widget A `<perspective-viewer>` instance to copy.
     */
    copy(widget) {
        if (widget.hasAttribute("index")) {
            this.setAttribute("index", widget.getAttribute("index"));
        }
        if (this._inner_drop_target) {
            this._inner_drop_target.innerHTML = widget._inner_drop_target.innerHTML;
        }

        if (widget._table) {
            this.load_table(widget._table);
        } else {
            widget._slaves.push(this);
        }
    }

    /**
     * Deletes this element's data and clears it's internal state (but not its
     * user state).  This (or the underlying `perspective.table`'s equivalent
     * method) must be called in order for its memory to be reclaimed.
     *
     * @returns {Promise<boolean>} Whether or not this call resulted in the
     * underlying `perspective.table` actually being deleted.
     */
    delete() {
        let x = this._clear_state();
        if (this._plugin.delete) {
            this._plugin.delete.call(this);
        }
        const resize_handler = _.debounce(this.notifyResize, 250).bind(this);
        window.removeEventListener("load", resize_handler);
        window.removeEventListener("resize", resize_handler);
        return x;
    }

    /**
     * Serialize this element's attribute/interaction state.
     *
     * @returns {object} a serialized element.
     */
    save() {
        let obj = {};
        for (let key = 0; key < this.attributes.length; key++) {
            let attr = this.attributes[key];
            if (["id"].indexOf(attr.name) === -1) {
                obj[attr.name] = attr.value;
            }
        }
        return obj;
    }

    /**
     * Restore this element to a state as generated by a reciprocal call to
     * `save`.
     *
     * @param {object} x returned by `save`.
     * @returns {Promise<void>} A promise which resolves when the changes have
     * been applied.
     */
    async restore(x) {
        for (let key in x) {
            let val = x[key];
            if (typeof val !== "string") {
                val = JSON.stringify(val);
            }
            this.setAttribute(key, val);
        }
        await this._debounce_update();
    }

    /**
     * Reset's this element's view state and attributes to default.  Does not
     * delete this element's `perspective.table` or otherwise modify the data
     * state.
     *
     */
    reset() {
        this.setAttribute("row-pivots", JSON.stringify([]));
        this.setAttribute("column-pivots", JSON.stringify([]));
        this.setAttribute("filters", JSON.stringify([]));
        this.setAttribute("sort", JSON.stringify([]));
        this.removeAttribute("index");
        if (this._initial_col_order) {
            this.setAttribute("columns", JSON.stringify(this._initial_col_order || []));
        } else {
            this.removeAttribute("columns");
        }
        this.setAttribute("view", Object.keys(renderers.getInstance())[0]);
        this.dispatchEvent(new Event("perspective-config-update"));
    }

    /**
     * Copies this element's view data (as a CSV) to the clipboard.  This method
     * must be called from an event handler, subject to the browser's
     * restrictions on clipboard access.  See
     * {@link https://www.w3.org/TR/clipboard-apis/#allow-read-clipboard}.
     *
     */
    handleClipboardCopy(options) {
        let data;
        if (!this._view) {
            console.warn("No view to copy - skipping");
            return;
        }
        this._view
            .to_csv(options)
            .then(csv => {
                data = csv;
            })
            .catch(err => {
                console.error(err);
                data = "";
            });
        let count = 0,
            f = () => {
                if (typeof data !== "undefined") {
                    copy_to_clipboard(data);
                } else if (count < 200) {
                    count++;
                    setTimeout(f, 50);
                } else {
                    console.warn("Timeout expired - copy to clipboard cancelled.");
                }
            };
        f();
    }
}

/**
 * `perspective-config-update` is fired whenever an configuration attribute has
 * been modified, by the user or otherwise.
 *
 * @event View#perspective-config-update
 * @type {string}
 */

/**
 * `perspective-view-update` is fired whenever underlying `view`'s data has
 * updated, including every invocation of `load` and `update`.
 *
 * @event View#perspective-view-update
 * @type {string}
 */
