var gulp = require('gulp'),
    uglify = require('gulp-uglify'),
    ngAnnotate = require('gulp-ng-annotate'),
    concat = require('gulp-concat'),
    rename = require('gulp-rename')
;


gulp.task('build', function() {
    gulp.src('./src/**/*.js')
        .pipe(ngAnnotate({
            add: true,
            remove: true,
            single_quotes: true
        }))
        .pipe(concat('script.js'))
        .pipe(gulp.dest('./dist/'))
        .pipe(rename('script.min.js'))
        .pipe(gulp.dest('../Bachmans-Admin/bower_components/bachmans-common/dist'))
        .pipe(uglify())
        .pipe(rename('script.min.js'))
        .pipe(gulp.dest('./dist/'));
});