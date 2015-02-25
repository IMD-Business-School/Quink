/**
 * Copyright (c), 2013-2014 IMD - International Institute for Management Development, Switzerland.
 *
 * See the file license.txt for copying permission.
 */

define([
    'Underscore',
    'jquery',
    'rangy-core',
    'hithandler/HitHandler',
    'locrange/LocRangeUtil',
    'util/Env',
    'util/Event',
    'util/PubSub'
], function (_, $, rangy, HitHandler, LocRangeUtil, Env, Event, PubSub) {
    'use strict';

    var FocusTracker = function () {
        this.states = [];
        this.onSelectionChangeThrottled = _.throttle(this.onSelectionChange.bind(this), 100);
        this.sclCount = 0;
    };

    FocusTracker.prototype.init = function (selector) {
        var onTextInsert = this.onTextInsert.bind(this);
        $('body').on('orientationchange', this.onOrientationChange);
        $(window).on('scroll', this.onScroll());
        HitHandler.register(this);
        $(selector)
            .on('blur', this.onBlur.bind(this))
            .on('focus', this.onFocus.bind(this))
            .on('scroll', this.onEditableScroll.bind(this));
        // Ensure there's always an editable.
        this.editable = $(selector)[0];
        this.lastEditable = this.editable;
        this.firstFocus = true;
        this.bindSelectionEvents();
        PubSub.subscribe('insert.char', onTextInsert);
        PubSub.subscribe('plugin.saved', onTextInsert);
        PubSub.subscribe('insert.text', onTextInsert);
        PubSub.subscribe('insert.html', onTextInsert);
    };

    /**
     * If the browser supports selectionchange events use them. Otherwise do the best that we can.
     */
    FocusTracker.prototype.bindSelectionEvents = function () {
        var onSelectionChange = this.onSelectionChangeThrottled;
        if (document.onselectionchange === undefined) {
            PubSub.subscribe('command.executed', onSelectionChange);
            PubSub.subscribe('nav.executed', onSelectionChange);
            PubSub.subscribe('plugin.exited', onSelectionChange);
            PubSub.subscribe('editable.range', onSelectionChange);
            PubSub.subscribe('insert.char', function () {
                setTimeout(onSelectionChange, 20);
            });
            PubSub.subscribe('plugin.saved', onSelectionChange);
            PubSub.subscribe('insert.text', onSelectionChange);
            PubSub.subscribe('insert.html', onSelectionChange);
        }
    };

    /**
     * The event is generated by the browser before the orientation change is complete.
     * Wait until after completion. Would be better to detect this rather than go on a timer.
     */
    FocusTracker.prototype.onOrientationChange = function (event) {
        setTimeout(function () {
            PubSub.publish('event.orientationchange', event);
        }, 500);
    };

    /**
     * Only fire scroll events if there has actually been scrolling. No idea why the browser seems to be firing
     * scroll events when no scrolling has taken place.
     */
    FocusTracker.prototype.onScroll = function () {
        var lastScrollTop = 0;
        return function (event) {
            var scrollTop = $('body').scrollTop();
            if (scrollTop !== lastScrollTop) {
                PubSub.publish('window.scroll', event);
                lastScrollTop = scrollTop;
            }
        };
    };

    FocusTracker.prototype.onEditableScroll = function (event) {
        PubSub.publish('editable.scroll', event);
    };

    /**
     * On Android Chrome a blur event can cause the document's insertion point to change incorrectly.
     * This attempts to detect that situation and uses the value stored by Quink in preference to
     * the one in the browser.
     * This only seems to happen on Android Chrome.
     */
    FocusTracker.prototype.checkRange = function (range) {
        var nr = range.nativeRange;
        if (Env.isAndroidChrome() &&
            (range.startContainer !== nr.startContainer ||
             range.startOffset !== nr.startOffset ||
             range.endContainer !== nr.endContainer ||
             range.endOffset !== nr.endOffset)) {
            range.setStart(range.startContainer, range.startOffset);
            range.setEnd(range.endContainer, range.endOffset);
        }
    };

    /**
     * Switch off the selection change handler to avoid an empty selection being saved.
     */
    FocusTracker.prototype.onBlur = function (event) {
        var editable = event.delegateTarget;
        this.lastEditable = editable;
        this.removeSelectionChangeListener();
        PubSub.publish('editable.blur', editable);
    };

    FocusTracker.prototype.onFocus = function (event) {
        var editable = event.delegateTarget,
            state = this.findState(editable);
        this.addSelectionChangeListener();
        this.editable = editable;
        this.lastEditable = editable;
        if (state.range) {
            this.checkRange(state.range);
            rangy.getSelection().setSingleRange(state.range);
        }
        PubSub.publish('editable.focus', editable);
    };

    /**
     * Sets the focus to the last editable that had the focus. Ensures that there is always
     * a range is the focused editable.
     */
    FocusTracker.prototype.createFocus = function () {
        var editable = this.lastEditable,
            state = this.findState(editable),
            range = state.range;
        editable.focus();
        if (!range) {
            range = rangy.createRange();
            range.setStart(editable, 0);
            range.collapse(true);
            state.range = range;
        }
        rangy.getSelection().setSingleRange(range);
        return range;
    };

    /**
     * Restores the focus to the last focused editable that has had a range. Will not create a range or focus
     * an editable if the editable does not have a range so the return can be falsey.
     */
    FocusTracker.prototype.restoreFocus = function () {
        var editable = this.lastEditable,
            state = this.findState(editable),
            range = state.range;
        if (range) {
            editable.focus();
            rangy.getSelection().setSingleRange(range);
        }
        return range;
    };

    /**
     * Removing focus from the current editable, but don't want that change in selection
     * to be reflected in the saved selection state for the editable.
     */
    FocusTracker.prototype.removeFocus = function () {
        this.storeState(this.editable);
        this.editable.blur();
    };

    /**
     * Make sure that selection change publications are only made if the new selection is within
     * the editable. On iOS the selection can be in a non-editable div.
     */
    FocusTracker.prototype.onSelectionChange = function () {
        var sel = rangy.getSelection(),
            range = sel.rangeCount && sel.getRangeAt(0);
        if (range && range.compareNode(this.editable) === range.NODE_BEFORE_AND_AFTER) {
            range.refresh();
            this.storeState(this.editable);
            PubSub.publish('selection.change', LocRangeUtil.getSelectionLoc);
        }
    };

    FocusTracker.prototype.addSelectionChangeListener = function () {
        if (this.sclCount) {
            console.log('addSelectionChangeListener for non zero count');
        } else {
            this.sclCount++;
            $(document).on('selectionchange.focustracker', this.onSelectionChangeThrottled);
        }
    };

    FocusTracker.prototype.removeSelectionChangeListener = function () {
        this.sclCount--;
        if (this.sclCount) {
            console.log('removeSelectionChangeListener doesn\'t leave zero count');
        }
        $(document).off('selectionchange.focustracker');
    };

    /**
     * Allow time for the DOM to be updated before saving the state.
     */
    FocusTracker.prototype.onTextInsert = function () {
        setTimeout(function () {
            this.storeState(this.editable);
        }.bind(this), 20);
    };

    FocusTracker.prototype.findState = function (editable) {
        var state = _.find(this.states, function (state) {
                return state.editable === editable;
            });
        if (!state) {
            state = {
                editable: editable
            };
            this.states.push(state);
        }
        return state;
    };

    FocusTracker.prototype.storeState = function (editable) {
        var state = this.findState(editable);
        state.range = this.getRange(editable);
        state.bodyScrollTop = this.bodyScrollTop;
        state.scrollTop = this.scrollTop;
        return state;
    };

    /**
     * Returns the current range if it's in the editable.
    */
    FocusTracker.prototype.getRange = function (editable) {
        var sel = rangy.getSelection(),
            range = sel.rangeCount && sel.getRangeAt(0),
            result;
        if (range && $(range.startContainer).closest(editable).length) {
            result = range;
        }
        return result;
    };

    /**
     * Executes func every delay interval until func returns true.
     */
    FocusTracker.prototype.until = function until(func, delay) {
        if (!func()) {
            _.delay(until, delay, func, delay);
        }
    };

    /**
     * Allow time for the range to be set within the document. It seems to take ages on iOS.
     * Returns false to allow other hit handlers to access the same event.
     */
    FocusTracker.prototype.handle = function (event) {
        var storeState = function () {
                var editable = Event.getEditable(event.event),
                    executed;
                if (this.getRange(editable)) {
                    executed = true;
                    this.storeState(editable[0]);
                    if (document.onselectionchange === undefined) {
                        this.onSelectionChange();
                    }
                }
                return executed;
            }.bind(this);
        this.until(storeState, 10);
        return false;
    };

    FocusTracker.prototype.getCurrentEditable = function () {
        return this.editable;
    };

    var theInstance = new FocusTracker();

    return {
        init: theInstance.init.bind(theInstance),
        restoreFocus: theInstance.restoreFocus.bind(theInstance),
        createFocus: theInstance.createFocus.bind(theInstance),
        removeFocus: theInstance.removeFocus.bind(theInstance),
        getCurrentEditable: theInstance.getCurrentEditable.bind(theInstance)
    };
});
