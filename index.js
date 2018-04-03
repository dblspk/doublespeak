const doublespeak = new Doublespeak(true);
var encQueue = [];
var textarea = [];

document.onreadystatechange = function () {
	if (!window.TextEncoder) {
		const script = document.createElement('script');
		script.src = 'polyfills/text-encoding.js';
		document.head.appendChild(script);
	}

	const textareas = [
		'out-prepend',
		'out-append',
		'out-plain',
		'out-cover',
		'out-cipher',
		'in-cipher',
		'in-plain'
	];
	for (var i = 0; i < 7; i++) {
		let name = textareas[i].replace(/-([a-z])/, (m, c) => c.toUpperCase());
		textarea[name] = document.getElementById(textareas[i]);
		if (i < 4 || i == 5)
			textarea[name].addEventListener('focus', function () { this.select(); });
	}

	resizeBody();
	document.body.onresize = () => { resizeBody(); };
	textarea.outPrepend.addEventListener('change', () => {
		localStorage.setItem('outPrepend', textarea.outPrepend.value);
	});
	textarea.outAppend.addEventListener('change', () => {
		localStorage.setItem('outAppend', textarea.outAppend.value);
	});
	textarea.outPlain.addEventListener('input', function () { mirrorCover(this); });
	textarea.outCover.addEventListener('input', function () { mirrorCover(this); });
	textarea.outCipher.addEventListener('focus', () => {
		document.getElementById('copy-out').click();
	});
	textarea.outCipher.addEventListener('copy', embedData);
	textarea.outCipher.addEventListener('dragstart', embedData);
	textarea.inCipher.addEventListener('paste', extractData);
	textarea.inCipher.addEventListener('drop', extractData);
	textarea.inCipher.addEventListener('input', checkEmpty);
	document.addEventListener('dragover', dragOverFiles);

	textarea.outPrepend.value = localStorage.getItem('outPrepend');
	textarea.outAppend.value = localStorage.getItem('outAppend');

	// Service worker caches page for offline use
	if ('serviceWorker' in navigator)
		navigator.serviceWorker.register('/sw.js');

	if (/Mac|iP(hone|od|ad)/.test(navigator.userAgent)) {
		textarea.outCipher.placeholder = 'Copy [Command+C] encoded message';
		textarea.inCipher.placeholder = 'Paste [Command+V] to decode message';
	}
};

// Mirror cover text to ciphertext box, pretending to embed data
// Embed does not actually occur until copy event
// Visual cues are still important for intuitive UX
function mirrorCover(el) {
	resizeTextarea(el);
	if (el === textarea.outCover) {
		textarea.outCipher.value = textarea.outCover.value;
		resizeTextarea(textarea.outCipher);
	}
	flashBorder(textarea.outCipher, 'encoded', 200);
}

// Select and copy text to clipboard
function copyText() {
	textarea.outCipher.select();
	document.execCommand('copy');
}

// Embed output ciphertext in cover text
function embedData(e) {
	const plainStr = (v => v ? v + ' ' : '')(textarea.outPrepend.value) +
		textarea.outPlain.value + (v => v ? ' ' + v : '')(textarea.outAppend.value);
	const encodedStr = doublespeak.encodeText(plainStr).concat(...encQueue);
	const coverStr = doublespeak.filterStr(textarea.outCover.value);
	// Select random position in cover text to insert ciphertext
	const insertPos = Math.floor(Math.random() * (coverStr.length - 1) + 1);
	const embeddedStr = coverStr.slice(0, insertPos) + encodedStr + coverStr.slice(insertPos);

	// Hijack copy/drag event to embed ciphertext
	if (e.type == 'copy') {
		e.preventDefault();
		e.clipboardData.setData('text/plain', embeddedStr);
	} else
		e.dataTransfer.setData('text/plain', embeddedStr);

	flashBorder(textarea.outCipher, 'copied', 800);
}

// Extract input ciphertext
function extractData(e) {
	e.preventDefault();
	// Hijack paste/drop event to extract clipboard contents
	const str = e.type == 'paste' ?
		e.clipboardData.getData('text/plain') :
		e.dataTransfer.getData('text/plain');

	// Filter out ciphertext before "pasting" to avert
	// reflow performance cost with large messages
	const { cover, dataObjs } = doublespeak.decodeData(str);
	clearInPlain();
	textarea.inCipher.value = cover || '\uFEFF';
	resizeTextarea(textarea.inCipher);

	for (var obj of dataObjs)
		switch (obj.dataType) {
			case 0x1:
				outputDecText(obj.data, obj.crcMatch);
				break;
			case 0x2:
				outputDecFile(obj.data, obj.crcMatch);
				break;
			default:
				outputError(getTextDiv(), obj.error, obj.details);
		}
}

function outputDecText(bytes, crcMatch) {
	autolinker.embeds = [];
	const references = {
		'&': '&amp;',
		'<': '&lt;',
		'>': '&gt;'
	};
	const textDiv = getTextDiv();
	textDiv.onfocus = function () { selectText(this); };
	// 1. Decode byte array to UTF-8
	// 2. Sanitize unsafe HTML characters
	// 3. Linkify URLs
	textDiv.innerHTML = autolinker.link(doublespeak.extractText(bytes).replace(/[&<>]/g, c => references[c]));

	if (!crcMatch)
		outputError(textDiv, 'CRC mismatch');

	embedMedia();

	flashBorder(textDiv, 'decoded', 1000);
}

function outputDecFile(bytes, crcMatch) {
	const { type, name, url, size } = doublespeak.extractFile(bytes);

	// Generate file details UI
	const textDiv = getTextDiv();
	textDiv.classList.add('file');
	textDiv.textContent = name;
	const info = document.createElement('p');
	info.className = 'file-info';
	info.textContent = (type || 'unknown') + ', ' + (size / 1024).toFixed(2) + ' KB';
	textDiv.appendChild(info);
	const link = document.createElement('a');
	link.className = 'file-download';
	link.href = url;
	link.download = name;
	link.tabIndex = -1;
	textDiv.appendChild(link);

	if (!crcMatch)
		outputError(textDiv, 'CRC mismatch');

	autolinker.embeds = [];
	collectEmbed(link.href, name);
	embedMedia();

	flashBorder(textDiv, 'decoded', 1000);
}

const autolinker = new Autolinker({
	stripPrefix: false,
	stripTrailingSlash: false,
	hashtag: 'twitter',
	replaceFn: match => {
		if (match.getType() == 'url')
			collectEmbed(match.getUrl());
		return match.buildTag().setAttr('tabindex', -1);
	}
});

// Collect embeddable URL
function collectEmbed(url, name) {
	const ext = (m => m && m[1])(/\.(\w{3,4})$/.exec(name || url));
	if (ext) {
		if (/^(jpe?g|gif|png|bmp|svg)$/i.test(ext))
			autolinker.embeds.push({ type: 'image', url });
		else if (/^(mp4|webm|gifv|ogv)$/i.test(ext))
			autolinker.embeds.push({ type: 'video', url });
		else if (/^(mp3|wav|ogg)$/i.test(ext))
			autolinker.embeds.push({ type: 'audio', url });
	} else {
		// Extract ID and timestamp components
		const youtube = /youtu(?:\.be\/|be\.com\/(?:embed\/|.*v=))([\w-]+)(?:.*start=(\d+)|.*t=(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?)?/.exec(url);
		if (youtube)
			autolinker.embeds.push({ type: 'youtube', id: youtube[1], h: youtube[3] || 0, m: youtube[4] || 0, s: youtube[5] || youtube[2] || 0 });
		const vimeo = /vimeo\.com\/(?:video\/)?(\d+)/.exec(url);
		if (vimeo)
			autolinker.embeds.push({ type: 'vimeo', id: vimeo[1] });
	}
}

function embedMedia() {
	if (!autolinker.embeds.length) return;
	// Generate embed container
	const embedDiv = document.createElement('div');
	embedDiv.className = 'embed-div';
	// Embed media
	for (var embed of autolinker.embeds)
		switch (embed.type) {
			case 'image':
				const div = document.createElement('div');
				div.className = 'embed-img-container blocked';
				const img = document.createElement('img');
				img.className = 'embed';
				img.onerror = function () { this.style.display = 'none'; };
				img.onload = function () { checkZoomable(this); };
				img.onclick = function () { clickImage(this); };
				img.src = embed.url;
				div.appendChild(img);
				embedDiv.appendChild(div);
				break;
			case 'video':
			case 'audio':
				const media = document.createElement(embed.type);
				media.className = 'embed';
				media.src = embed.url.replace(/gifv$/i, 'mp4');
				media.loop = /gifv$/i.test(embed.url) && true;
				media.controls = true;
				media.preload = 'metadata';
				media.tabIndex = -1;
				embedDiv.appendChild(media);
				break;
			case 'youtube':
			case 'vimeo':
				const iframe = document.createElement('iframe');
				iframe.className = 'embed';
				if (embed.type === 'youtube')
					iframe.src = 'https://www.youtube.com/embed/' + embed.id + '?start=' +
						(embed.h * 3600 + embed.m * 60 + parseInt(embed.s));
				else
					iframe.src = 'https://player.vimeo.com/video/' + embed.id;
				iframe.allowFullscreen = true;
				iframe.tabIndex = -1;
				embedDiv.appendChild(iframe);
		}
	textarea.inPlain.appendChild(embedDiv);
}

function getTextDiv() {
	let textDiv;
	if (textarea.inPlain.lastChild.innerHTML) {
		// Generate pseudo-textarea
		textDiv = document.createElement('div');
		textDiv.className = 'text-div';
		textDiv.tabIndex = -1;
		textarea.inPlain.appendChild(textDiv);
	}
	return textDiv || textarea.inPlain.lastChild;
}

function dragOverFiles(e) {
	e.stopPropagation();
	e.dataTransfer.dropEffect = 'copy';

	if ((a => a[a.length - 1])(e.dataTransfer.types) == 'Files') {
		e.preventDefault();
		const dropTarget = document.getElementById('drop-target');
		dropTarget.style.display = 'block';
		dropTarget.addEventListener('dragleave', () => {
			dropTarget.style.display = 'none';
		}, { once: true });
	}
}

function dropFiles(e) {
	e.stopPropagation();
	e.preventDefault();
	document.getElementById('drop-target').style.display = 'none';

	readFiles(e.dataTransfer.files);
}

function readFiles(files) {
	for (var i = 0; i < files.length; i++)
		(file => {
			const reader = new FileReader();
			reader.onload = () => {
				enqueueEncFile(file.type, file.name, new Uint8Array(reader.result));
			};
			reader.readAsArrayBuffer(file);
		})(files[i]);
}

// Convert file header and byte array to encoding characters and push to output file queue
function enqueueEncFile(type, name, bytes) {
	encQueue.push(doublespeak.encodeFile(type, name, bytes));
	warnEncSize();

	// Generate file details UI
	const textDiv = document.createElement('div');
	textDiv.className = 'text-div file';
	textDiv.textContent = name;
	const remove = document.createElement('button');
	remove.className = 'file-remove';
	remove.onclick = function () { removeEncFile(this); };
	remove.tabIndex = -1;
	remove.innerHTML = '&times;';
	textDiv.appendChild(remove);
	const info = document.createElement('p');
	info.className = 'file-info';
	info.textContent = (type || 'unknown') + ', ' + (bytes.length / 1024).toFixed(2) + ' KB';
	textDiv.appendChild(info);
	textarea.outPlain.parentElement.appendChild(textDiv);
}

// Remove file from output file queue
function removeEncFile(el) {
	const textDiv = el.parentElement;
	const parent = textDiv.parentElement;
	const index = Array.prototype.indexOf.call(parent.children, textDiv) - 4;
	encQueue.splice(index, 1);
	warnEncSize();
	parent.removeChild(textDiv);
}

function warnEncSize() {
	let queueSize = encQueue.reduce((size, str) => size + str.length * 3, 0);
	let warnSize = document.getElementById('warn-size');
	// Warn if output file queue is over 4 MB
	if (queueSize > 0x400000) {
		document.getElementById('warn-size-kb').textContent = (queueSize / 1024).toFixed(2);
		warnSize.style.display = 'block';
	} else
		warnSize.style.display = 'none';
}

function outputError(el, msg = 'Protocol mismatch', details = '') {
	console.error(msg, details);
	el.classList.add('error');
	const errorDiv = document.createElement('div');
	errorDiv.className = 'notify error-div';
	errorDiv.textContent = msg.toUpperCase();
	el.parentElement.appendChild(errorDiv);
}

function flashBorder(el, style, ms) {
	el.classList.add(style);
	setTimeout(() => {
		el.classList.remove(style);
	}, ms);
}

function checkEmpty() {
	if (textarea.inCipher.value == '')
		clearIn();
}

function selectText(el) {
	const range = document.createRange();
	const selection = window.getSelection();
	range.selectNodeContents(el);
	selection.removeAllRanges();
	selection.addRange(range);
}

function clearOutPlain() {
	encQueue = [];
	warnEncSize();
	const outPlainParent = textarea.outPlain.parentElement;
	while (outPlainParent.childNodes.length > 4)
		outPlainParent.removeChild(outPlainParent.lastChild);
	textarea.outPlain.value = '';
	resizeTextarea(textarea.outPlain);
	textarea.outPlain.focus();
}

function clearOut() {
	textarea.outCover.value = '';
	textarea.outCipher.value = '';
	resizeTextarea(textarea.outCover);
	resizeTextarea(textarea.outCipher);
	textarea.outCover.focus();
}

function clearIn() {
	clearInPlain();
	textarea.inCipher.value = '';
	resizeTextarea(textarea.inCipher);
	textarea.inCipher.focus();
}

function clearInPlain() {
	const inPlain = textarea.inPlain;
	inPlain.firstChild.innerHTML = '';
	inPlain.firstChild.className = 'text-div';
	inPlain.firstChild.onfocus = null;
	while (inPlain.childNodes.length > 1)
		inPlain.removeChild(inPlain.lastChild);
}

function clickImage(el) {
	const parent = el.parentElement;
	if (parent.classList.contains('blocked'))
		parent.classList.remove('blocked');
	else if (el.classList.contains('zoomable')) {
		const fontSize = parseFloat(document.documentElement.style.fontSize);
		// Clone clicked image at same position
		const zoom = el.cloneNode();
		zoom.id = 'zoom';
		zoom.style.top = el.height * 0.5 + fontSize * 0.1 + parent.offsetTop + parent.offsetParent.offsetTop - (document.documentElement.scrollTop || document.body.scrollTop) + 'px';
		zoom.style.left = el.width * 0.5 + fontSize * 0.1 + parent.offsetLeft + 'px';
		zoom.onclick = function () { unzoomImage(); };
		const bg = document.createElement('div');
		bg.id = 'background';
		requestAnimationFrame(() => bg.style.opacity = 0.9);
		bg.onclick = function () { unzoomImage(); };
		document.body.appendChild(bg);
		document.body.appendChild(zoom);
		// Force element reflow to enable transition
		void zoom.offsetWidth;
		zoom.removeAttribute('style');
		// Zoom image
		zoom.className = 'zoom-end';
		zoom.origin = el;
	}
}

function unzoomImage() {
	const fontSize = parseFloat(document.documentElement.style.fontSize);
	const zoom = document.getElementById('zoom');
	const parent = zoom.origin.parentElement;
	// Unzoom image
	zoom.style.top = zoom.origin.height * 0.5 + fontSize * 0.1 + parent.offsetTop + parent.offsetParent.offsetTop - (document.documentElement.scrollTop || document.body.scrollTop) + 'px';
	zoom.style.left = zoom.origin.width * 0.5 + fontSize * 0.1 + parent.offsetLeft + 'px';
	zoom.style.width = zoom.origin.width + 'px';
	const bg = document.getElementById('background');
	requestAnimationFrame(() => bg.style.opacity = 0);
	zoom.addEventListener('transitionend', () => {
		document.body.removeChild(zoom);
		document.body.removeChild(bg);
	}, { once: true });
}

function checkZoomable(el) {
	const embedWidth = textarea.inPlain.scrollWidth;
	if (el) {
		if (el.naturalWidth > embedWidth)
			el.classList.add('zoomable');
		return;
	}
	const images = textarea.inPlain.getElementsByTagName('img');
	for (var i = 0; i < images.length; i++) {
		if (images[i].naturalWidth > embedWidth)
			images[i].classList.add('zoomable');
		else
			images[i].classList.remove('zoomable');
	}
}

function clickNav(el) {
	const labels = document.getElementsByTagName('label');
	for (var i = 0; i < 2; i++)
		labels[i].classList.remove('selected');
	el.classList.add('selected');
	if (el.getAttribute('for') === 'nav-main')
		setTimeout(() => {
			resizeBody();
		});
}

// Scale elements according to viewport size
function resizeBody() {
	if (window.innerWidth > 480 && screen.width > 480)
		document.documentElement.style.fontSize = Math.min(window.innerWidth, window.innerHeight) * 0.03 + 'px';
	else
		document.documentElement.style.fontSize = Math.min(window.innerWidth, window.innerHeight * 1.2) * 0.045 + 'px';
	resizeTextarea(textarea.outPlain);
	resizeTextarea(textarea.outCover);
	resizeTextarea(textarea.outCipher);
	resizeTextarea(textarea.inCipher);
	checkZoomable();
}

// Scale textarea according to font size
function resizeTextarea(el) {
	const fontSize = parseFloat(document.documentElement.style.fontSize);
	el.style.height = '';
	el.style.height = Math.min(el.scrollHeight + fontSize * 0.24, fontSize * 12) + 'px';
}
