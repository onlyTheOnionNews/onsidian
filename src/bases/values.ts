// obsidian.d.ts Bases `Value` classes, wrapping the evaluator's internal values for plugin views (BasesEntry.getValue).
import moment from 'moment';
import type { App } from '../app';
import { Duration, HtmlVal, IconVal, ImageVal, LinkVal, isDate, isFile, toText, truthy, type Val } from './expr';

export abstract class Value {
	static type = 'value';
	static equals(a: Value | null, b: Value | null): boolean { return (a?.toString() ?? null) === (b?.toString() ?? null) && a?.constructor === b?.constructor; }
	static looseEquals(a: Value | null, b: Value | null): boolean { return (a?.toString() ?? '') === (b?.toString() ?? ''); }
	abstract toString(): string;
	abstract isTruthy(): boolean;
	equals(other: this): boolean { return Value.equals(this, other); }
	looseEquals(other: Value): boolean { return Value.looseEquals(this, other); }
	renderTo(el: HTMLElement, _ctx?: unknown): void { el.setText(this.toString()); }
	/** @internal raw evaluator value */
	abstract get raw(): Val;
}
export abstract class NotNullValue extends Value {}
export class NullValue extends Value {
	static type = 'null';
	static value = new NullValue();
	toString(): string { return ''; }
	isTruthy(): boolean { return false; }
	get raw(): Val { return null; }
}
export abstract class PrimitiveValue<T> extends NotNullValue {
	constructor(public data: T) { super(); }
	toString(): string { return String(this.data); }
	isTruthy(): boolean { return truthy(this.data as Val); }
	get raw(): Val { return this.data as Val; }
}
export class StringValue extends PrimitiveValue<string> { static type = 'string'; }
export class NumberValue extends PrimitiveValue<number> { static type = 'number'; }
export class BooleanValue extends PrimitiveValue<boolean> { static type = 'boolean'; }
export class TagValue extends StringValue { static type = 'tag'; }
export class UrlValue extends StringValue { static type = 'url'; }
export class LinkValue extends StringValue {
	static type = 'link';
	constructor(public link: LinkVal) { super(link.toString()); }
	get raw(): Val { return this.link; }
	static parseFromString(_app: App, input: string): LinkValue | null {
		const m = /^\[\[([^\]|]+)(?:\|([^\]]*))?\]\]$/.exec(input.trim());
		return m ? new LinkValue(new LinkVal(m[1], m[2])) : null;
	}
}
export class DateValue extends NotNullValue {
	static type = 'date';
	constructor(public date: moment.Moment) { super(); }
	toString(): string { return toText(this.date); }
	isTruthy(): boolean { return true; }
	dateOnly(): DateValue { return new DateValue(this.date.clone().startOf('day')); }
	relative(): string { return this.date.fromNow(); }
	get raw(): Val { return this.date; }
	static parseFromString(input: string): DateValue | null {
		const m = moment(input, [moment.ISO_8601, 'YYYY-MM-DD'], true);
		return m.isValid() ? new DateValue(m) : null;
	}
}
export class RelativeDateValue extends DateValue {}
export class DurationValue extends NotNullValue {
	static type = 'duration';
	constructor(public duration: Duration) { super(); }
	toString(): string { return toText(this.duration); }
	isTruthy(): boolean { return true; }
	get raw(): Val { return this.duration; }
}
export class ListValue extends NotNullValue {
	static type = 'list';
	private items: Value[];
	constructor(value: (unknown | Value)[]) {
		super();
		this.items = value.map((v) => (v instanceof Value ? v : toApiValue(v as Val)));
	}
	toString(): string { return this.items.map((v) => v.toString()).join(', '); }
	isTruthy(): boolean { return this.items.length > 0; }
	includes(value: Value): boolean { return this.items.some((v) => Value.looseEquals(v, value)); }
	length(): number { return this.items.length; }
	get(index: number): Value { return this.items[index] ?? NullValue.value; }
	concat(other: ListValue): ListValue { return new ListValue([...this.items, ...other.items]); }
	get raw(): Val { return this.items.map((v) => v.raw); }
}
export class ObjectValue extends NotNullValue {
	static type = 'object';
	constructor(public data: Record<string, Val>) { super(); }
	toString(): string { return JSON.stringify(this.data); }
	isTruthy(): boolean { return Object.keys(this.data).length > 0; }
	get raw(): Val { return this.data; }
}
export class FileValue extends NotNullValue {
	static type = 'file';
	constructor(public file: Val) { super(); }
	toString(): string { return toText(this.file); }
	isTruthy(): boolean { return true; }
	get raw(): Val { return this.file; }
}
export class RegExpValue extends NotNullValue {
	static type = 'regexp';
	constructor(public regexp: RegExp) { super(); }
	toString(): string { return this.regexp.toString(); }
	isTruthy(): boolean { return true; }
	get raw(): Val { return this.regexp; }
}
export class HTMLValue extends NotNullValue {
	static type = 'html';
	constructor(public html: HtmlVal) { super(); }
	toString(): string { return this.html.html; }
	isTruthy(): boolean { return !!this.html.html; }
	get raw(): Val { return this.html; }
}
export class ImageValue extends NotNullValue {
	static type = 'image';
	constructor(public image: ImageVal) { super(); }
	toString(): string { return this.image.src; }
	isTruthy(): boolean { return true; }
	get raw(): Val { return this.image; }
}
export class IconValue extends NotNullValue {
	static type = 'icon';
	constructor(public icon: IconVal) { super(); }
	toString(): string { return this.icon.name; }
	isTruthy(): boolean { return true; }
	get raw(): Val { return this.icon; }
}

export function toApiValue(v: Val): Value {
	if (v === null || v === undefined) return NullValue.value;
	if (typeof v === 'string') return /^https?:\/\//.test(v) ? new UrlValue(v) : v.startsWith('#') ? new TagValue(v) : new StringValue(v);
	if (typeof v === 'number') return new NumberValue(v);
	if (typeof v === 'boolean') return new BooleanValue(v);
	if (isDate(v)) return new DateValue(v);
	if (v instanceof Duration) return new DurationValue(v);
	if (Array.isArray(v)) return new ListValue(v);
	if (v instanceof LinkVal) return new LinkValue(v);
	if (isFile(v)) return new FileValue(v);
	if (v instanceof RegExp) return new RegExpValue(v);
	if (v instanceof HtmlVal) return new HTMLValue(v);
	if (v instanceof ImageVal) return new ImageValue(v);
	if (v instanceof IconVal) return new IconValue(v);
	return new ObjectValue(v as Record<string, Val>);
}
