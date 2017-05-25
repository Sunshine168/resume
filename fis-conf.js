fis.config.set('pack', {
	//对合并的aio.css进行处理
	'aio.css': [
		'**.css'
	]

});
// 启用 fis-spriter-csssprites 插件
fis.match('::package', {
		spriter: fis.plugin('csssprites'),
	})
	// 对 CSS 进行图片合并
fis.match('*.css', {
	// 给匹配到的文件分配属性 `useSprite`
	useSprite: true,
});
fis.match('*.{js,css,png,gif}', {
	useHash: true // 开启 md5 戳
});

// 所有的 js
fis.match('**.js', {
	//发布到/static/js/目录下
	release: '/static/js/'
});

// 所有的 css
fis.match('**.css', {
	//发布到/static/css/目录下
	release: '/static/css/'
});

// 所有img目录下的.png，.gif文件
fis.match('/img/(*.{png,gif})', {
	//发布到/static/pic/目录下
	release: '/static/img/'
});

// 所有img目录下的.png，.gif文件
fis.match('/img/icon/(*.png)', {
	//发布到/static/pic/目录下
	release: '/static/img/icon/'
});
fis.match('/css/(*.png)', {
	//发布到/static/pic/目录下
	release: '/static/img/icon/'
});